require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { ethers } = require("ethers");
const OpenAI = require("openai");
const { MongoClient } = require("mongodb");

// Configure OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Ethereum Configuration
const API_KEY = process.env.ETHERSCAN_API_KEY;
const BASE_URL = "https://api.etherscan.io/api";
const INFURA_KEY = process.env.INFURA_PROJECT_ID;

const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${INFURA_KEY}`);

// MongoDB Configuration
const MONGO_URI = process.env.MONGO_URI;
let db;
const client = new MongoClient(MONGO_URI);

async function connectToMongo() {
    if (db) return db;
    try {
        await client.connect();
        db = client.db();
        console.log("✅ Connected to MongoDB");

        // Create a TTL index on the `cachedAt` field to expire documents after 2 days
        const cacheCollection = db.collection("transferCache");
        await cacheCollection.createIndex({ cachedAt: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 });

        return db;
    } catch (error) {
        console.error("Error connecting to MongoDB:", error.message);
        process.exit(1);
    }
}

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// Utility Functions
async function getContractCreator(contractAddress) {
    try {
        const response = await axios.get(
            `${BASE_URL}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${API_KEY}`
        );
        if (response.data.status === "1" && response.data.result) {
            return response.data.result[0].contractCreator;
        }
        return null;
    } catch (error) {
        console.error("Error getting contract creator:", error.message);
        return null;
    }
}

async function getOwnerTransfers(contractAddress, ownerAddress) {
    try {
        const response = await axios.get(
            `${BASE_URL}?module=account&action=tokentx&address=${ownerAddress}&contractaddress=${contractAddress}&startblock=0&endblock=99999999&sort=asc&apikey=${API_KEY}`
        );

        if (response.data.status === "1" && response.data.result) {
            return response.data.result.map((tx) => ({
                to: tx.to,
                value: parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal)),
                timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                hash: tx.hash,
            }));
        }
        return [];
    } catch (error) {
        console.error("Error getting transfers:", error.message);
        return [];
    }
}

async function getAddressName(address) {
    try {
        const ensName = await provider.lookupAddress(address);
        if (ensName) return ensName;

        const response = await axios.get(
            `${BASE_URL}?module=contract&action=getsourcecode&address=${address}&apikey=${API_KEY}`
        );
        if (response.data.status === "1" && response.data.result[0]) {
            return response.data.result[0].ContractName || null;
        }

        return null;
    } catch (error) {
        console.error(`Error getting name for ${address}:`, error.message);
        return null;
    }
}

function calculateWalletTotals(transfers) {
    const walletTotals = transfers.reduce((acc, transfer) => {
        if (!acc[transfer.to]) {
            acc[transfer.to] = {
                address: transfer.to,
                totalTokens: 0,
                transactions: [],
            };
        }
        acc[transfer.to].totalTokens += transfer.value;
        acc[transfer.to].transactions.push({
            value: transfer.value,
            timestamp: transfer.timestamp,
            hash: transfer.hash,
        });
        return acc;
    }, {});

    return Object.values(walletTotals).sort((a, b) => b.totalTokens - a.totalTokens);
}

async function addWalletNames(wallets) {
    return await Promise.all(
        wallets.map(async (wallet) => {
            const name = await getAddressName(wallet.address);
            return {
                ...wallet,
                name: name || null,
                numberOfTransactions: wallet.transactions.length,
            };
        })
    );
}

async function evaluateTransactionsWithChatGPT(top20Wallets) {
    const prompt = `
You are a highly skilled blockchain analyst specializing in Ethereum transaction patterns. Your task is to review and analyze data regarding the top 20 wallets receiving tokens from the deployer of a specific Ethereum smart contract. This analysis is crucial for identifying any risks, suspicious patterns, or anomalies in the token distribution process and assessing the potential impact on token holders, investors, and the ecosystem.

---

### **About the Data**:
The data provided summarizes token transactions initiated by the deployer of an Ethereum smart contract. These transactions represent the distribution of tokens to various wallets. Each entry contains:
1. **Wallet Address (to)**: The recipient's Ethereum address.
2. **Total Tokens Transferred (totalTokens)**: The aggregate number of tokens sent to this wallet.
3. **Number of Transactions (numberOfTransactions)**: The total number of token transfers made to this wallet.
4. **Transaction Details (transactions)**: A list of individual transactions, including:
   - **Value**: The number of tokens sent in the transaction.
   - **Timestamp**: The time the transaction was recorded on the blockchain.
   - **Hash**: The unique identifier for the transaction.

This data is critical for understanding the behavior of the deployer, assessing the fairness of token distribution, and identifying any potential risks or patterns that could impact the credibility of the smart contract or the token's ecosystem.

---

### **Purpose of the Analysis**:
The primary goals of this analysis are:
1. **Risk Identification**:
   - Detect any signs of unethical behavior, such as token dumping, sudden large transfers, or centralization risks.
   - Evaluate whether the distribution strategy aligns with best practices for transparency and fairness.

2. **Suspicious Pattern Detection**:
   - Identify irregularities such as repetitive small transfers to multiple wallets, large transfers to a single wallet, or bursts of high-volume transactions that may indicate manipulation or fraud.

3. **Impact Assessment**:
   - Assess how the deployer’s behavior could affect token holders, the broader ecosystem, and the token's long-term viability.

4. **Provide Actionable Insights**:
   - Deliver an objective assessment that stakeholders can use to make informed decisions about the risks and credibility of the smart contract and token.

---

### **Output Requirements**:
Provide a structured JSON response with your findings and risk assessment. Use the format below:
{
    "assessment": "A concise summary of risks, patterns, and findings.",
    "riskScore": "A single integer between 0 and 10, where 0 means no risk and 10 indicates very high risk."
}

---

### **Instructions**:
1. **Clear Language**:
   - Ensure the "assessment" field uses simple, clear language so that non-technical stakeholders can easily understand your findings. Provide specific examples when possible to clarify risks or patterns.

2. **Strict JSON Format**:
   - Adhere strictly to the JSON format provided above without any additional comments or text outside the JSON structure.

3. **Risk Score**:
   - Assign a "riskScore" between 0 and 10 based on the severity of identified risks:
     - 0: No risk.
     - 10: Extremely high risk with significant concerns.

---

### **Data for Evaluation**:
Below is the summary of token distributions from the deployer to the top 20 wallets:
${JSON.stringify(top20Wallets, null, 2)}

---

### **Important Note**:
Your response must adhere strictly to the JSON format provided above. Do not include any additional comments or text outside the JSON structure.
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content:
                        "You are a blockchain expert analyzing Ethereum transaction patterns to assess risks and anomalies. Your response must use clear and simple language to communicate findings effectively to non-technical stakeholders.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0,
        });

        const text = response.choices[0].message.content.trim();

        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
            throw new Error("No valid JSON found in ChatGPT response.");
        }
        const jsonString = text.substring(firstBrace, lastBrace + 1);

        const json = JSON.parse(jsonString);

        if (typeof json.assessment !== "string" || !/^\d$|^10$/.test(json.riskScore)) {
            throw new Error("Invalid JSON structure from ChatGPT response.");
        }

        return json;
    } catch (error) {
        console.error("Error evaluating transactions with ChatGPT:", error.message);
        return {
            assessment: "An error occurred during the evaluation. Unable to determine risks or provide insights.",
            riskScore: "1",
        };
    }
}



// Endpoint to Analyze Transfers
app.get("/api/analyze-transfers/:contractAddress", async (req, res) => {
    const { contractAddress } = req.params;

    if (!ethers.isAddress(contractAddress)) {
        return res.status(400).json({ error: "Invalid contract address." });
    }

    try {
        const db = await connectToMongo();
        const cacheCollection = db.collection("transferCache");

        // Check Cache
        const cachedResult = await cacheCollection.findOne({ contractAddress });
        if (cachedResult) {
            console.log("Cache hit for", contractAddress);
            return res.json(cachedResult.data);
        }

        const deployerAddress = await getContractCreator(contractAddress);
        if (!deployerAddress) {
            return res.status(500).json({ error: "Could not find deployer address." });
        }

        const transfers = await getOwnerTransfers(contractAddress, deployerAddress);
        if (transfers.length === 0) {
            return res.status(200).json({ message: "No transfers found." });
        }

        const walletTotals = calculateWalletTotals(transfers);
        const top20Wallets = await addWalletNames(walletTotals.slice(0, 20));
        const chatGPTResponse = await evaluateTransactionsWithChatGPT(top20Wallets);

        const result = {
            contractAddress,
            deployerAddress,
            top20Wallets,
            chatGPTAssessment: chatGPTResponse.assessment,
            riskScore: chatGPTResponse.riskScore,
        };

        // Cache the Result
        await cacheCollection.insertOne({ contractAddress, data: result, cachedAt: new Date() });

        return res.json(result);
    } catch (error) {
        console.error("Error analyzing transfers:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
