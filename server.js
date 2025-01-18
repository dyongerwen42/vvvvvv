/***********************************************************
 * server.js
 **********************************************************/
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const { JsonRpcProvider, Contract, isAddress, ethers } = require("ethers");
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");
const Bottleneck = require("bottleneck"); // Voor rate limiting

// Maak een OpenAI-instantie
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const INFURA_URL = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_URL = "https://api.etherscan.io/api";

// Minimale ERC20-ABI + Ownership-check
const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function owner() view returns (address)",
    "function renounceOwnership() public",
];

// ===== MongoDB Setup (native driver) =====
let db;
const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
app.use(express.static("public"));

async function connectMongo() {
    if (db) return db;
    try {
        await client.connect();
        db = client.db();
        console.log("✅ Verbonden met MongoDB");

        // Creëer een TTL-index op het veld 'createdAt' dat verwijdert na 24 uur (86400 seconden)
        const coll = db.collection("auditCache");
        await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });

        return db;
    } catch (err) {
        console.error("Fout bij verbinden met MongoDB:", err.message);
        process.exit(1);
    }
}

// =============== Helperfuncties =============== //

// JSON Extractie Helperfunctie
function extractJson(text) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        throw new Error("Geen geldige JSON gevonden in de response.");
    }
    const jsonString = text.substring(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(jsonString);
    } catch (err) {
        throw new Error("JSON parsing mislukt: " + err.message);
    }
}

// Clean comment by removing {{ and }}
function cleanComment(comment) {
    return comment.replace(/^\{\{|\}\}$/g, "");
}

// Retry helperfunctie
async function retryOperation(operation, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            console.warn(`Poging ${attempt} mislukt: ${err.message}`);
            if (attempt < retries) {
                await new Promise((res) => setTimeout(res, delay));
            } else {
                throw err;
            }
        }
    }
}

/**
 * Verwijdert zowel enkele als meervoudige commentaren uit Solidity-code.
 * @param {string} code - De originele Solidity-broncode.
 * @returns {string} - De broncode zonder commentaar.
 */
function removeComments(code) {
    // Verwijder enkele lijn commentaren
    let noSingleLine = code.replace(/\/\/.*$/gm, '');
    // Verwijder meervoudige lijn commentaren
    let noComments = noSingleLine.replace(/\/\*[\s\S]*?\*\//g, '');
    return noComments;
}

/**
 * Haal on-chain token data op (naam, symbool, decimals, totalSupply).
 */
async function fetchOnChainTokenData(address) {
    const provider = new JsonRpcProvider(INFURA_URL);
    const contract = new Contract(address, ERC20_ABI, provider);

    const name = await contract.name();
    const symbol = await contract.symbol();
    const decimals = await contract.decimals();
    const totalSupplyBN = await contract.totalSupply();

    console.log(`Token Name: ${name}`);
    console.log(`Token Symbol: ${symbol}`);
    console.log(`Decimals: ${decimals}`);
    console.log(`Total Supply: ${totalSupplyBN.toString()}`);

    return {
        name,
        symbol,
        decimals,
        totalSupply: totalSupplyBN.toString(),
    };
}

/**
 * Haal geverifieerde broncode en metadata op van Etherscan met rate limiting via Bottleneck.
 * Combineer de broncode direct zonder bestanden op te slaan.
 */
async function fetchEtherscanData(address) {
    return etherscanLimiter.schedule(async () => {
        try {
            console.log(`Fetching source code for contract: ${address}`);
            const response = await axios.get(ETHERSCAN_API_URL, {
                params: {
                    module: "contract",
                    action: "getsourcecode",
                    address,
                    apikey: ETHERSCAN_API_KEY,
                },
            });

            // Save the full API response for debugging
            const fullResponsePath = path.join(__dirname, `etherscan_response_${address}.json`);
            fs.writeFileSync(fullResponsePath, JSON.stringify(response.data, null, 2), "utf-8");
            console.log(`Saved full Etherscan response to: ${fullResponsePath}`);

            const data = response.data;
            if (data.status !== "1" || data.message !== "OK") {
                throw new Error(`Etherscan error: ${data.message}`);
            }

            const result = data.result[0];
            const sourceCode = result.SourceCode;

            if (!sourceCode || sourceCode.trim() === "") {
                throw new Error("No source code found. The contract might not be verified.");
            }

            let combinedSource = "";

            if (sourceCode.startsWith("{") && sourceCode.endsWith("}")) {
                console.log("Detected multi-file contract.");
                let parsedSource;
                try {
                    parsedSource = JSON.parse(sourceCode.slice(1, -1)); // Verwijder wikkelaccolades
                } catch (err) {
                    console.error("Error parsing multi-file source code JSON:", err.message);
                    throw err;
                }

                const sources = parsedSource.sources;

                // Combineer alle broncodebestanden in één string
                for (const [fileName, fileContent] of Object.entries(sources)) {
                    combinedSource += `\n// File: ${fileName}\n\n${fileContent.content}\n`;
                }

                console.log(`Combined multi-file contract length: ${combinedSource.length}`);
            } else {
                console.log("Detected single-file contract.");
                combinedSource = sourceCode;
                console.log(`Combined single-file contract length: ${combinedSource.length}`);
            }

            return {
                ContractName: result.ContractName,
                CompilerVersion: result.CompilerVersion,
                OptimizationUsed: result.OptimizationUsed,
                LicenseType: result.LicenseType,
                SourceCode: combinedSource,
            };
        } catch (error) {
            console.error(`Error fetching Etherscan data for contract ${address}:`, error.message);
            throw error;
        }
    });
}

/**
 * Haal de huidige eigenaar van het contract op.
 */
async function fetchContractOwner(address) {
    const provider = new JsonRpcProvider(INFURA_URL);
    const contract = new Contract(address, ERC20_ABI, provider);

    try {
        const owner = await contract.owner();
        console.log(`Current Owner: ${owner}`);
        return owner;
    } catch (err) {
        console.warn(`Kon owner niet ophalen voor ${address}:`, err.message);
        // Retourneer null zodat we weten dat het niet beschikbaar is
        return null;
    }
}

/**
 * Laad de JSON-template (met placeholders).
 */
function loadTemplate() {
    const raw = fs.readFileSync(path.join(__dirname, "template.json"), "utf8");
    return JSON.parse(raw);
}

/**
 * Vervang placeholders (zoals {{Token Naam}}) in een string.
 */
function replacePlaceholders(str, replacements) {
    if (typeof str !== "string") return str;
    let result = str;
    for (const [key, value] of Object.entries(replacements)) {
        const placeholder = `{{${key}}}`;
        result = result.replace(new RegExp(placeholder, "g"), value);
    }
    return result;
}

/**
 * Recursief placeholders in het hele JSON-object vervangen.
 */
function fillTemplateRecursive(obj, replacements) {
    if (Array.isArray(obj)) {
        return obj.map((item) => fillTemplateRecursive(item, replacements));
    } else if (obj && typeof obj === "object") {
        const newObj = {};
        for (const [key, val] of Object.entries(obj)) {
            newObj[key] = fillTemplateRecursive(val, replacements);
        }
        return newObj;
    } else if (typeof obj === "string") {
        return replacePlaceholders(obj, replacements);
    }
    return obj;
}

/**
 * Recursief doorloop een object en converteer alle BigInt-waarden naar strings.
 * Converteer ook Date-objecten naar ISO strings.
 */
function convertBigIntToString(obj) {
    if (typeof obj === "bigint") {
        return obj.toString();
    } else if (obj instanceof Date) {
        return obj.toISOString();
    } else if (Array.isArray(obj)) {
        return obj.map(convertBigIntToString);
    } else if (obj && typeof obj === "object") {
        const newObj = {};
        for (const [key, value] of Object.entries(obj)) {
            newObj[key] = convertBigIntToString(value);
        }
        return newObj;
    }
    return obj;
}

/**
 * Vraag ChatGPT om (redFlag, comment) te bepalen voor één item.
 */
async function askChatGPTForItem(itemKey, description, instruction, context) {
    // Construct the prompt with enhanced instructions
    const prompt = `
Audit this smart contract:
Contract Name: ${context.contractName}
Ownership Renounced: ${context.renounceStatus || "Not Available"}
Full Smart Contract: ${context.sourceCodeSnippet}

We need to evaluate the audit item "${itemKey}".
Description: ${description}
Instruction: ${instruction}

Please provide a JSON response in the following exact format only:
{
    "redFlag": true/false,
    "comment": "{explanation}",
    "criticalityScore": "{{1-10}}"
}

**Guidelines:**
1. Ensure the response is strictly in JSON format as shown above.
2. Do not include any additional text, explanations, or markdown outside the JSON structure.
3. The "comment" field must be a concise explanation that non-technical people can understand. Use examples if helpful.
4. Use the provided source code snippet to inform your assessment.
5. **Relevance Check:** First determine if the audit item is applicable to the contract. If it is not related, set "redFlag" to false with an appropriate comment.
6. **Consider Ownership Renouncement:** Explicitly take the ownership renouncement status into account. Highlight how this status influences the audit item's evaluation and the potential risks.
7. **Avoid False Positives:** Only set "redFlag" to true if there is a genuine risk identified in relation to the contract.
8. **Criticality Score:** If a red flag is identified ("redFlag": true), assign a criticality score from 1 to 10, where:
   - 1 represents a very low criticality.
   - 10 represents a very high criticality.

**Examples:**

**Valid response:**
{
    "redFlag": true,
    "comment": "Ownership renouncement increases the risk due to lack of administrative control. For example, if something goes wrong, there is no way to fix the contract.",
    "criticalityScore": "8"
}
`;

    // Define the operation to interact with OpenAI's API
    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Ensure the correct model name
            messages: [
                {
                    role: "system",
                    content:
                        "You are an AI specializing in auditing smart contracts. Provide concise and accurate assessments based on the provided information. Always explain in simple language that non-technical people can understand, and use examples if helpful.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0, // Ensure deterministic output
        });

        const text = response.choices[0].message.content.trim();
        console.log(`ChatGPT Response for ${itemKey}:`, text);

        try {
            const json = extractJson(text);
            console.log(`Parsed JSON for ${itemKey}:`, json);

            // Validate the JSON structure
            if (
                typeof json.redFlag !== "boolean" ||
                typeof json.comment !== "string" ||
                !/^[1-9]$|^10$/.test(json.criticalityScore)
            ) {
                throw new Error("Invalid JSON structure from ChatGPT");
            }

            // Optional: Clean the comment to remove unwanted characters or formatting
            json.comment = cleanComment(json.comment);

            return json;
        } catch (error) {
            console.error(`Error parsing JSON from ChatGPT for ${itemKey}:`, error.message);
            throw new Error("Invalid JSON response");
        }
    };

    try {
        // Retry the operation up to 3 times with a 1-second delay between retries
        return await retryOperation(operation, 3, 1000);
    } catch (err) {
        console.error(`Error with ChatGPT for ${itemKey} after retries:`, err.message);
        // Fallback response if all retries fail
        return { redFlag: false, comment: "Error or invalid response.", criticalityScore: "1" };
    }
}





/**
 * Vraag ChatGPT om eindconclusie (summary, recommendations, etc.).
 */
async function askChatGPTForConclusion(allResults, context) {
    const summaryText = JSON.stringify(allResults, null, 2);

    const prompt = `
Here is a collection of audit results for various items (redFlag and comment):
${summaryText}

Please provide a conclusion in valid JSON with the following structure:
{
    "summary": "...",
    "dangers": ["Danger 1", "Danger 2", "Danger 3", "Danger 4"],
    "comments": "...",
    "totalRiskScore": "1-10"
}

**Instructions:**
1. The "summary" should give an overall assessment based on the audit results, in a way non-technical people can easily understand.
2. The "dangers" must list all potential risks related to the owner's rights in the contract. Use clear language and examples if helpful.
3. The "comments" field should include any additional observations or notes, written in a simple and accessible manner.
4. The "totalRiskScore" should be a number between 1 and 10, where 10 indicates the highest risk.
5. Ensure the JSON format is strictly followed without any additional text or explanations.

**Examples:**

**Valid response:**
{
    "summary": "The contract exhibits significant risks due to the owner's ability to mint unlimited tokens without oversight.",
    "dangers": ["Owner can mint unlimited tokens", "No governance on critical operations", "Lack of slippage protection", "Inadequate decentralization mechanisms"],
    "comments": "While the contract follows basic ERC standards, it lacks critical safety measures like multi-sig and timelocks.",
    "totalRiskScore": "8"
}

**For context:**
Smart Contract: ${context.sourceCodeSnippet}
`;

    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Correct model name
            messages: [
                {
                    role: "system",
                    content:
                        "You are an AI security auditor specializing in smart contract assessments. Provide concise and accurate conclusions based on the provided audit results. Use simple language that non-technical people can easily understand, and include examples if helpful.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0, // Ensure deterministic output
        });

        const text = response.choices[0].message.content.trim();
        console.log("ChatGPT Conclusion Response:", text);

        try {
            const json = extractJson(text);
            if (
                typeof json.summary !== "string" ||
                !Array.isArray(json.dangers) ||
                typeof json.comments !== "string" ||
                (typeof json.totalRiskScore !== "string" && typeof json.totalRiskScore !== "number")
            ) {
                throw new Error("Invalid JSON structure from ChatGPT for conclusion.");
            }
            json.summary = cleanComment(json.summary);
            json.comments = cleanComment(json.comments);
            return json;
        } catch (error) {
            console.error("Error parsing JSON from ChatGPT conclusion:", error.message);
            throw new Error("Invalid JSON response");
        }
    };

    try {
        return await retryOperation(operation, 3, 1000);
    } catch (err) {
        console.error("Error with ChatGPT conclusion after retries:", err.message);
        return {
            summary: "Could not generate a conclusion.",
            dangers: [],
            comments: "An error occurred.",
            totalRiskScore: "N/A",
        };
    }
}


// ======== Bottleneck Rate Limiter voor Etherscan ========
const etherscanLimiter = new Bottleneck({
    maxConcurrent: 5, // maximaal 5 gelijktijdige verzoeken
    minTime: 200, // minimaal 200ms tussen verzoeken (1000ms / 5 = 200ms)
});

// =============== Task Queue Implementatie =============== //
class TaskQueue {
    constructor(rateLimit = Infinity, interval = 0) {
        this.queue = [];
        this.rateLimit = rateLimit;
        this.interval = interval;
        this.active = false;
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.active) return;
        this.active = true;
        while (this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();
            try {
                const result = await task();
                resolve(result);
            } catch (err) {
                reject(err);
            }
            if (this.interval > 0) {
                await this.sleep(this.interval / this.rateLimit);
            }
        }
        this.active = false;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Init task queue zonder rate limiting, aangezien Bottleneck dit al regelt voor Etherscan
const auditQueue = new TaskQueue(Infinity, 0);

// =============== RATE LIMITING OP API =============== //
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minuten
    max: 100, // maximaal 100 verzoeken per IP
    message: "Te veel verzoeken van deze IP, probeer het later opnieuw.",
});

app.use("/api/", apiLimiter);

// =============== Ownership and Proxy Check =============== //
// Constants for ownership and proxy checks
const OWNERSHIP_TRANSFER_TOPIC = ethers.id("OwnershipTransferred(address indexed,address indexed)");
const PROXY_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OWNERSHIP_FUNCTION_NAMES = ["owner", "getowner", "admin", "getadmin", "manager", "governance", "controller"];
const STANDARD_FUNCTIONS = {
    "owner()": "0x8da5cb5b",
    "getOwner()": "0x893d20e8",
    "admin()": "0xf851a440",
    "manager()": "0x481c6a75",
    "governance()": "0x5aa6e675"
};

async function checkContractOwnership(contractAddress) {
    const provider = new JsonRpcProvider(INFURA_URL);
    try {
        console.log('🔌 Connecting to Ethereum network for ownership check...');
        await provider.getNetwork();
        console.log('✅ Connected successfully');

        // Validate Contract Address
        if (!ethers.isAddress(contractAddress)) {
            console.error('❌ Invalid contract address provided.');
            return { error: 'Invalid contract address provided.' };
        }

        const code = await provider.getCode(contractAddress);
        if (code === '0x') {
            console.error('❌ Address is not a contract');
            return { error: 'Address is not a contract' };
        }

        console.log('\n📝 Analyzing contract for ownership:', contractAddress);

        let ownershipRenounced = true;
        let ownerFound = false;
        const functionCallResults = {};
        const ownershipFunctions = [];
        let proxyAdminAddress = null;
        let proxyAdminError = null;

        // 1. Check Standard Functions - Improved Error Handling and Output
        console.log('\n🔎 Checking common ownership functions...');
        for (const [funcName, signature] of Object.entries(STANDARD_FUNCTIONS)) {
            try {
                const result = await provider.call({ to: contractAddress, data: signature });
                if (result !== '0x' && result !== '0x' + '00'.repeat(32)) {
                    const address = ethers.getAddress('0x' + result.slice(-40));
                    functionCallResults[funcName] = address;
                    if (address !== ethers.ZeroAddress) {
                        console.log(`🔍 ${funcName} returned: ${address}`);
                        ownershipRenounced = false;
                        ownerFound = true;
                    } else {
                        console.log(`✅ Ownership likely renounced (${funcName})`);
                    }
                } else {
                    console.log(`✅ Ownership likely renounced (${funcName})`);
                }
            } catch (error) {
                console.log(`⚠️ Call to ${funcName} failed. This usually means the function does not exist on this contract: ${error.reason || error.message}`);
            }
        }

        // 2. Check ABI for Ownership Functions - Enhanced ABI Handling and Error Management
        console.log("\n--- Checking with ABI ---");
        if (!process.env.ETHERSCAN_API_KEY) {
            console.warn("⚠️ ETHERSCAN_API_KEY not set in .env. Skipping ABI check.");
        } else {
            try {
                const abiResponse = await axios.get(`${ETHERSCAN_API_URL}?module=contract&action=getabi&address=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`);
                if (abiResponse.status !== 200) {
                    console.error(`❌ Etherscan API request failed with status ${abiResponse.status}`);
                } else {
                    const abiData = abiResponse.data;

                    if (abiData.status === "1" && abiData.result !== "Contract source code not verified") {
                        const contractABI = JSON.parse(abiData.result);
                        const contract = new ethers.Contract(contractAddress, contractABI, provider);

                        for (const item of contractABI) {
                            if (item.type === "function" && OWNERSHIP_FUNCTION_NAMES.includes(item.name.toLowerCase())) {
                                ownershipFunctions.push(item);
                            }
                        }

                        if (ownershipFunctions.length > 0) {
                            console.log("🔍 Potential ownership functions found in ABI:", ownershipFunctions.map(f => f.name));
                            ownershipRenounced = false;

                            for (const func of ownershipFunctions) {
                                try {
                                    const ownerFromABI = await contract[func.name]();
                                    console.log(`🔍 ${func.name} from ABI: ${ownerFromABI}`);
                                    if (ownerFromABI !== ethers.ZeroAddress) {
                                        ownerFound = true;
                                    } else {
                                        console.log(`✅ ${func.name} from ABI indicates renounced ownership.`);
                                    }
                                } catch (abiError) {
                                    console.error(`⚠️ Error calling ${func.name} from ABI:`, abiError.message);
                                }
                            }
                        } else {
                            console.log("No clear ownership functions found in ABI.");
                        }
                    } else {
                        console.log("⚠️ Could not fetch ABI from Etherscan or contract source not verified.");
                    }
                }
            } catch (error) {
                console.error("❌ Error fetching ABI", error);
            }
        }

        // 3. Check Proxy Admin - Improved Output
        console.log('\n🔄 Checking for Proxy Admin...');
        try {
            const proxyAdmin = await provider.getStorage(contractAddress, PROXY_ADMIN_SLOT);
            if (proxyAdmin !== ethers.ZeroHash) {
                proxyAdminAddress = ethers.getAddress("0x" + proxyAdmin.slice(-40));
                console.log(`🔍 Proxy admin address: ${proxyAdminAddress}`);
                ownershipRenounced = false;
            } else {
                console.log("✅ No proxy admin found.");
            }
        } catch (e) {
            proxyAdminError = e.message;
            console.log(`⚠️ Could not retrieve proxy admin (Expected for non-proxy contracts). ${proxyAdminError}`);
        }

        // 4. Check Ownership Transfer Events - More Informative Logging
        console.log('\n📜 Checking latest ownership event...');
        try {
            const events = await provider.getLogs({
                address: contractAddress,
                topics: [OWNERSHIP_TRANSFER_TOPIC],
                fromBlock: 0
            });

            if (events.length > 0) {
                const lastEvent = events[events.length - 1];
                const iface = new ethers.Interface(["event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"]);
                const decodedEvent = iface.parseLog(lastEvent);
                console.log(`🔍 Latest transfer: From ${decodedEvent.args.previousOwner} To ${decodedEvent.args.newOwner}`);
                if (decodedEvent.args.newOwner !== ethers.ZeroAddress) {
                    ownershipRenounced = false;
                } else {
                    console.log("✅ Ownership transferred to zero address in latest event.");
                }
            } else {
                console.log('✅ No ownership transfer events found.');
            }
        } catch (e) {
            console.log('⚠️ Could not retrieve ownership transfer events:', e.message);
        }

        return {
            ownershipRenounced,
            ownerFound,
            functionCallResults,
            ownershipFunctions: ownershipFunctions.map(f => f.name),
            proxyAdminAddress,
            proxyAdminError
        };

    } catch (error) {
        console.error('\n❌ Fatal Error during ownership check:', error.message);
        return { error: error.message };
    }
}

// =============== ROUTE /api/audit/:contractAddress =============== //
app.get("/api/audit/:contractAddress", async (req, res) => {
    const { contractAddress } = req.params;
    if (!isAddress(contractAddress)) {
        return res.status(400).json({ error: "Ongeldig contractadres." });
    }
    try {
        const db = await connectMongo();
        const coll = db.collection("auditCache");
        const cached = await coll.findOne({ contractAddress });
        if (cached) {
            console.log(`[Cache-hit] audit voor ${contractAddress}`);
            const sanitizedCachedReport = convertBigIntToString(cached.auditReport);
            return res.json(sanitizedCachedReport);
        }

        console.log(`[Cache-miss] audit voor ${contractAddress}. Ophalen...`);

        const auditTask = async () => {
            const [tokenData, etherscanData, ownerAddress, ownershipCheckResult] = await Promise.all([
                fetchOnChainTokenData(contractAddress),
                fetchEtherscanData(contractAddress),
                fetchContractOwner(contractAddress),
                checkContractOwnership(contractAddress),
            ]);
        
            // Check for errors in ownership check
            if (ownershipCheckResult.error) {
                console.error("Error during ownership check:", ownershipCheckResult.error);
                return res.status(500).json({ error: `Error during ownership check: ${ownershipCheckResult.error}` });
            }
        
            // Determine ownership status
            let renounceStatus = "Unknown";
            if (ownershipCheckResult.ownershipRenounced && !ownershipCheckResult.ownerFound) {
                renounceStatus = "Ownership likely renounced";
            } else if (!ownershipCheckResult.ownershipRenounced && ownershipCheckResult.ownerFound) {
                renounceStatus = "Ownership not renounced";
            } else {
                renounceStatus = "Ownership status uncertain";
            }
        
            // Proxy admin status
            let proxyAdminStatus = "No proxy admin detected";
            if (ownershipCheckResult.proxyAdminAddress) {
                proxyAdminStatus = `Proxy admin found: ${ownershipCheckResult.proxyAdminAddress}`;
            } else if (ownershipCheckResult.proxyAdminError) {
                proxyAdminStatus = `Error checking for proxy admin: ${ownershipCheckResult.proxyAdminError}`;
            }
        
            // Clean source code for ChatGPT context
            const sourceSnippetOriginal = etherscanData.SourceCode;
            const sourceSnippetCleaned = removeComments(sourceSnippetOriginal);
        
            let template = loadTemplate();
            template = fillTemplateRecursive(template, {
                "Token Naam": tokenData?.name || "N/A",
                "Token Symbool": tokenData?.symbol || "N/A",
                "Aantal Decimalen": tokenData?.decimals?.toString() || "N/A",
                "Totale Voorraad": tokenData?.totalSupply || "N/A",
                "Ownership Renounced": renounceStatus,
                "Proxy Admin Status": proxyAdminStatus,
            });
        
            const checklist = template.contractAuditChecklist;
            const resultsSummary = {};
        
            for (const categoryKey of Object.keys(checklist)) {
                const category = checklist[categoryKey];
                for (const itemKey of Object.keys(category)) {
                    const itemDef = category[itemKey];
                    const description = itemDef.description;
                    const instruction = itemDef.instruction;
        
                    const gptResult = await askChatGPTForItem(itemKey, description, instruction, {
                        contractName: etherscanData.ContractName || "Unknown",
                        sourceCodeSnippet: sourceSnippetCleaned,
                        renounceStatus: renounceStatus || "Unknown",
                        ownershipFunctions: ownershipCheckResult.ownershipFunctions || [],
                        ownerAddress: ownershipCheckResult.functionCallResults.owner || "N/A",
                    });
        
                    // Append ChatGPT results to item definition
                    itemDef.redFlag = gptResult.redFlag.toString();
                    itemDef.comment = gptResult.comment;
                    itemDef.criticalityScore = gptResult.criticalityScore;
        
                    // Add to summary
                    resultsSummary[itemKey] = {
                        redFlag: gptResult.redFlag,
                        comment: gptResult.comment,
                        criticalityScore: gptResult.criticalityScore,
                    };
                }
            }
        
            // Generate a conclusion
            const conclusion = await askChatGPTForConclusion(resultsSummary, {
                contractName: etherscanData.ContractName || "Unknown",
                sourceCodeSnippet: sourceSnippetCleaned,
            });
            template.conclusion.summary = conclusion.summary;
            template.conclusion.dangers = conclusion.dangers;
            template.conclusion.comments = conclusion.comments;
            template.conclusion.totalRiskScore = conclusion.totalRiskScore;
            template.auditByAIBadge = true;
            // Add detailed information to final report
            const auditReport = {
                contractAddress,
                tokenData,
                etherscanData,
                renounceStatus,
                proxyAdminStatus,
                ownershipCheckResult,
                finalTemplate: template,
                createdAt: new Date(),
                contract: sourceSnippetOriginal,
                resultsSummary, // Include results with criticality scores
            };
        
            console.log("Audit Report Contract Length:", auditReport.contract.length);
            console.log("Audit Report Contract Sample:", auditReport.contract.substring(0, 500)); // Eerste 500 karakters
        
            const sanitizedAuditReport = convertBigIntToString(auditReport);
            await coll.insertOne({ contractAddress, auditReport: sanitizedAuditReport });
            console.log(`✅ Gecached in MongoDB: audit voor ${contractAddress}`);
        
            return sanitizedAuditReport;
        };
        

        const auditResult = await auditQueue.enqueue(auditTask);
        return res.json(auditResult);
    } catch (err) {
        console.error("Fout in /api/audit/:contractAddress:", err.message);
        return res.status(500).json({ error: err.message });
    }
});


// =============== ROUTE /:contractAddress =============== //




app.get("/home", (req, res) => {
    res.sendFile(path.join(__dirname,"public" , "home.html"));
});

app.get("/:contractAddress", (req, res) => {
    res.sendFile(path.join(__dirname,"public" ,"index.html"));
});

// =============== ROUTE / (optioneel) =============== //
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname,"public" , "index.html"));
});

// =============== Start de server + DB connect =============== //
connectMongo().then(() => {
    app.listen(port, () => {
        console.log(`Server draait op http://localhost:${port}`);
    });
});
