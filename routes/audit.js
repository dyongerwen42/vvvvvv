// routes/audit.js
const express = require("express");
const router = express.Router();
const { isAddress } = require("ethers");
const { connectMongo } = require("../services/db");
const {
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
} = require("../services/auditServices"); // We zullen deze functies verder opdelen
const TaskQueue = require("../services/taskQueue"); // Verondersteld dat dit ook in services is
const rateLimit = require("express-rate-limit");
const Bottleneck = require("bottleneck");

// Rate limiter specifiek voor deze route (optioneel)
const auditLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minuten
    max: 100, // maximaal 100 verzoeken per IP
    message: "Te veel verzoeken van deze IP, probeer het later opnieuw.",
});

router.use(auditLimiter);

// Initialiseer Bottleneck of andere services indien nodig
const auditQueue = new TaskQueue(Infinity, 0);

router.get("/:contractAddress", async (req, res) => {
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

module.exports = router;
