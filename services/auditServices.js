// services/auditServices.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { JsonRpcProvider, Contract, isAddress, ethers } = require("ethers");
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");
const Bottleneck = require("bottleneck"); // Voor rate limiting

require("dotenv").config();

// OpenAI-instantie
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Rate limiter voor Etherscan
const etherscanLimiter = new Bottleneck({
    maxConcurrent: 5, // maximaal 5 gelijktijdige verzoeken
    minTime: 200, // minimaal 200ms tussen verzoeken
});

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

// Verwijdert zowel enkele als meervoudige commentaren uit Solidity-code.
function removeComments(code) {
    // Verwijder enkele lijn commentaren
    let noSingleLine = code.replace(/\/\/.*$/gm, '');
    // Verwijder meervoudige lijn commentaren
    let noComments = noSingleLine.replace(/\/\*[\s\S]*?\*\//g, '');
    return noComments;
}

// Haal on-chain token data op (naam, symbool, decimals, totalSupply).
async function fetchOnChainTokenData(address) {
    const INFURA_URL = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
    const ERC20_ABI = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function totalSupply() view returns (uint256)",
        "function owner() view returns (address)",
        "function renounceOwnership() public",
    ];
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

// Haal geverifieerde broncode en metadata op van Etherscan met rate limiting via Bottleneck.
async function fetchEtherscanData(address) {
    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
    const ETHERSCAN_API_URL = "https://api.etherscan.io/api";

    return etherscanLimiter.schedule(async () => {
        try {
            console.log(`Fetching source code voor contract: ${address}`);
            const response = await axios.get(ETHERScan_API_URL, {
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
            console.error(`Error fetching Etherscan data voor contract ${address}:`, error.message);
            throw error;
        }
    });
}

// Haal de huidige eigenaar van het contract op.
async function fetchContractOwner(address) {
    const INFURA_URL = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
    const ERC20_ABI = [
        "function owner() view returns (address)",
    ];
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

// Laad de JSON-template (met placeholders).
function loadTemplate() {
    const raw = fs.readFileSync(path.join(__dirname, "../template.json"), "utf8");
    return JSON.parse(raw);
}

// Vervang placeholders (zoals {{Token Naam}}) in een string.
function replacePlaceholders(str, replacements) {
    if (typeof str !== "string") return str;
    let result = str;
    for (const [key, value] of Object.entries(replacements)) {
        const placeholder = `{{${key}}}`;
        result = result.replace(new RegExp(placeholder, "g"), value);
    }
    return result;
}

// Recursief placeholders in het hele JSON-object vervangen.
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

// Recursief doorloop een object en converteer alle BigInt-waarden naar strings.
// Converteer ook Date-objecten naar ISO strings.
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

// Vraag ChatGPT om (redFlag, comment) te bepalen voor één item.
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
3. The "comment" field must be a concise explanation.
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
    "comment": "Ownership renouncement increases the risk due to lack of administrative control.",
    "criticalityScore": "8"
}
`;

    // Define the operation to interact with OpenAI's API
    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Zorg ervoor dat dit de juiste modelnaam is
            messages: [
                {
                    role: "system",
                    content:
                        "You are an AI specializing in auditing smart contracts. Provide concise and accurate assessments based on the provided information.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0, // Zorg voor deterministische output
        });

        const text = response.choices[0].message.content.trim();
        console.log(`ChatGPT Response voor ${itemKey}:`, text);

        try {
            const json = extractJson(text);
            console.log(`Parsed JSON voor ${itemKey}:`, json);

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
            console.error(`Error parsing JSON van ChatGPT voor ${itemKey}:`, error.message);
            throw new Error("Invalid JSON response");
        }
    };

    try {
        // Retry the operation up to 3 times with a 1-second delay between retries
        return await retryOperation(operation, 3, 1000);
    } catch (err) {
        console.error(`Error met ChatGPT voor ${itemKey} na retries:`, err.message);
        // Fallback response if all retries fail
        return { redFlag: false, comment: "Error or invalid response.", criticalityScore: "1" };
    }
}

// Vraag ChatGPT om eindconclusie (summary, recommendations, etc.).
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
1. The "summary" should give an overall assessment based on the audit results.
2. The "dangers" a list with all the dangers of the rights that owners have in this contract.
3. The "comments" field can include any additional observations or notes.
4. The "totalRiskScore" should be a number between 1 and 10, where 10 indicates the highest risk.
5. Ensure the JSON format is strictly followed without any additional text or explanations.

**Examples:**

**Valid response:**
{
    "summary": "summary",
    "dangers": ["Danger 1", "Danger 2", "Danger 3", "Danger 4"],
    "comments": "commnents",
    "totalRiskScore": "Risicoscore"
}
    **for context :**
    smart contract: ${context.sourceCodeSnippet}
`;

    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Zorg ervoor dat dit de juiste modelnaam is
            messages: [
                {
                    role: "system",
                    content:
                        "You are an AI security auditor specializing in smart contract assessments. Provide concise and accurate conclusions based on the provided audit results.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0,
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
            console.error("Error parsing JSON van ChatGPT conclusion:", error.message);
            throw new Error("Invalid JSON response");
        }
    };

    try {
        return await retryOperation(operation, 3, 1000);
    } catch (err) {
        console.error("Error met ChatGPT conclusion na retries:", err.message);
        return {
            summary: "Kon geen conclusie genereren.",
            dangers: [],
            comments: "Fout opgetreden.",
            totalRiskScore: "N/A",
        };
    }
}

// Ownership and Proxy Check functies
async function checkContractOwnership(contractAddress) {
    const INFURA_URL = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
    const provider = new JsonRpcProvider(INFURA_URL);
    const ERC20_ABI = [
        "function owner() view returns (address)",
        "function getOwner() view returns (address)",
        "function admin() view returns (address)",
        "function getadmin() view returns (address)",
        "function manager() view returns (address)",
        "function governance() view returns (address)",
        "function controller() view returns (address)",
    ];

    const OWNERSHIP_TRANSFER_TOPIC = ethers.id("OwnershipTransferred(address indexed,address indexed)");
    const PROXY_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const STANDARD_FUNCTIONS = {
        "owner()": "0x8da5cb5b",
        "getOwner()": "0x893d20e8",
        "admin()": "0xf851a440",
        "manager()": "0x481c6a75",
        "governance()": "0x5aa6e675"
    };

    try {
        console.log('🔌 Verbinden met Ethereum netwerk voor ownership check...');
        await provider.getNetwork();
        console.log('✅ Verbonden succesvol');

        // Validate Contract Address
        if (!ethers.isAddress(contractAddress)) {
            console.error('❌ Ongeldig contractadres opgegeven.');
            return { error: 'Ongeldig contractadres opgegeven.' };
        }

        const code = await provider.getCode(contractAddress);
        if (code === '0x') {
            console.error('❌ Adres is geen contract');
            return { error: 'Adres is geen contract' };
        }

        console.log('\n📝 Analyseren contract voor ownership:', contractAddress);

        let ownershipRenounced = true;
        let ownerFound = false;
        const functionCallResults = {};
        const ownershipFunctions = [];
        let proxyAdminAddress = null;
        let proxyAdminError = null;

        // 1. Check Standard Functions
        console.log('\n🔎 Controleren van standaard ownership functies...');
        for (const [funcName, signature] of Object.entries(STANDARD_FUNCTIONS)) {
            try {
                const result = await provider.call({ to: contractAddress, data: signature });
                if (result !== '0x' && result !== '0x' + '00'.repeat(32)) {
                    const address = ethers.getAddress('0x' + result.slice(-40));
                    functionCallResults[funcName] = address;
                    if (address !== ethers.constants.AddressZero) {
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
                console.log(`⚠️ Call to ${funcName} mislukt. Dit betekent meestal dat de functie niet bestaat in dit contract: ${error.reason || error.message}`);
            }
        }

        // 2. Check ABI for Ownership Functions
        console.log("\n--- Controleren met ABI ---");
        if (!process.env.ETHERSCAN_API_KEY) {
            console.warn("⚠️ ETHERSCAN_API_KEY niet ingesteld in .env. ABI check overslaan.");
        } else {
            try {
                const ETHERSCAN_API_URL = "https://api.etherscan.io/api";
                const abiResponse = await axios.get(`${ETHERSCAN_API_URL}?module=contract&action=getabi&address=${contractAddress}&apikey=${process.env.ETHERSCAN_API_KEY}`);
                if (abiResponse.status !== 200) {
                    console.error(`❌ Etherscan API verzoek mislukt met status ${abiResponse.status}`);
                } else {
                    const abiData = abiResponse.data;

                    if (abiData.status === "1" && abiData.result !== "Contract source code not verified") {
                        const contractABI = JSON.parse(abiData.result);
                        const contract = new ethers.Contract(contractAddress, contractABI, provider);

                        for (const item of contractABI) {
                            if (item.type === "function" && ["owner", "getowner", "admin", "getadmin", "manager", "governance", "controller"].includes(item.name.toLowerCase())) {
                                ownershipFunctions.push(item);
                            }
                        }

                        if (ownershipFunctions.length > 0) {
                            console.log("🔍 Mogelijke ownership functies gevonden in ABI:", ownershipFunctions.map(f => f.name));
                            ownershipRenounced = false;

                            for (const func of ownershipFunctions) {
                                try {
                                    const ownerFromABI = await contract[func.name]();
                                    console.log(`🔍 ${func.name} uit ABI: ${ownerFromABI}`);
                                    if (ownerFromABI !== ethers.constants.AddressZero) {
                                        ownerFound = true;
                                    } else {
                                        console.log(`✅ ${func.name} uit ABI geeft aan dat ownership is gerenzeerd.`);
                                    }
                                } catch (abiError) {
                                    console.error(`⚠️ Fout bij het aanroepen van ${func.name} uit ABI:`, abiError.message);
                                }
                            }
                        } else {
                            console.log("Geen duidelijke ownership functies gevonden in ABI.");
                        }
                    } else {
                        console.log("⚠️ Kan ABI niet ophalen van Etherscan of contractbron niet geverifieerd.");
                    }
                }
            } catch (error) {
                console.error("❌ Fout bij het ophalen van ABI", error);
            }
        }

        // 3. Check Proxy Admin
        console.log('\n🔄 Controleren op Proxy Admin...');
        try {
            const proxyAdmin = await provider.getStorage(contractAddress, PROXY_ADMIN_SLOT);
            if (proxyAdmin !== ethers.constants.HashZero) {
                proxyAdminAddress = ethers.getAddress("0x" + proxyAdmin.slice(-40));
                console.log(`🔍 Proxy admin adres: ${proxyAdminAddress}`);
                ownershipRenounced = false;
            } else {
                console.log("✅ Geen proxy admin gevonden.");
            }
        } catch (e) {
            proxyAdminError = e.message;
            console.log(`⚠️ Kon proxy admin niet ophalen (Verwacht voor niet-proxy contracts). ${proxyAdminError}`);
        }

        // 4. Check Ownership Transfer Events
        console.log('\n📜 Controleren op laatste ownership event...');
        try {
            const events = await provider.getLogs({
                address: contractAddress,
                topics: [OWNERSHIP_TRANSFER_TOPIC],
                fromBlock: 0
            });

            if (events.length > 0) {
                const lastEvent = events[events.length - 1];
                const iface = new ethers.utils.Interface(["event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"]);
                const decodedEvent = iface.parseLog(lastEvent);
                console.log(`🔍 Laatste overdracht: Van ${decodedEvent.args.previousOwner} Naar ${decodedEvent.args.newOwner}`);
                if (decodedEvent.args.newOwner !== ethers.constants.AddressZero) {
                    ownershipRenounced = false;
                } else {
                    console.log("✅ Ownership overgedragen aan nul adres in laatste event.");
                }
            } else {
                console.log('✅ Geen ownership transfer events gevonden.');
            }
        } catch (e) {
            console.log('⚠️ Kon ownership transfer events niet ophalen:', e.message);
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
        console.error('\n❌ Fout tijdens ownership check:', error.message);
        return { error: error.message };
    }
}

module.exports = {
    fetchOnChainTokenData,
    fetchEtherscanData,
    fetchContractOwner,
    checkContractOwnership,
    removeComments,
    loadTemplate,
    fillTemplateRecursive,
    askChatGPTForItem,
    askChatGPTForConclusion,
    convertBigIntToString,
};
