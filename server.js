require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ==================================================
// CONFIG
// ==================================================

const PREFIX = "najeef_chaman_";
const MAX_KEYS_PER_IP = 5;
const MAX_KEYS_PER_USER = 10;
const MAX_REQUESTS_PER_KEY = 100;

// Comma-separated list of admin emails, e.g. "you@gmail.com,partner@gmail.com"
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// Allowed expiration options (in hours). null = no expiration.
const EXPIRATION_OPTIONS = {
    "15d": 15 * 24,
    "1m": 30 * 24,
    "6m": 182 * 24,
    "none": null
};

// ==================================================
// FIREBASE ADMIN INIT
// ==================================================

let firebaseReady = false;

try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, "firebase-service-account.json"),
                "utf8"
            )
        );
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    firebaseReady = true;
    console.log("Firebase Admin initialized.");
} catch (error) {
    console.error("Firebase Admin initialization failed:");
    console.error(error.message);
    console.error("Login-protected routes will not work until this is fixed.");
}

// ==================================================
// MONGODB CONNECTION
// ==================================================

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("MONGODB_URI not set in environment variables.");
    process.exit(1);
}

mongoose
    .connect(MONGODB_URI)
    .then(() => {
        console.log("MongoDB connected successfully.");
    })
    .catch((error) => {
        console.error("MongoDB connection failed:");
        console.error(error.message);
        process.exit(1);
    });

// ==================================================
// SCHEMAS
// ==================================================

const apiKeySchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, default: "Unnamed key" },
    ip: { type: String, required: true, index: true },
    email: { type: String, required: true, index: true },
    uid: { type: String, required: true, index: true },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, default: null }, // null = never expires
    revoked: { type: Boolean, default: false },
    requests: { type: Number, default: 0 }
});

// TTL index only removes documents where expiresAt is a real date in the past.
// Documents with expiresAt: null are never touched by this index.
apiKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ApiKey = mongoose.model("ApiKey", apiKeySchema);

const userSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, index: true },
    provider: { type: String, default: "unknown" },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    totalKeysGenerated: { type: Number, default: 0 },
    blocked: { type: Boolean, default: false }
});

const User = mongoose.model("User", userSchema);

// ==================================================
// LOAD QURAN JSON
// ==================================================

const quranPath = path.join(__dirname, "quran_full.json");
let quranData;

try {
    quranData = JSON.parse(fs.readFileSync(quranPath, "utf8"));
    if (!Array.isArray(quranData)) {
        throw new Error("quran_full.json must contain an array.");
    }
    console.log(`Quran records loaded: ${quranData.length}`);
} catch (error) {
    console.error("Failed to load quran_full.json");
    console.error(error.message);
    process.exit(1);
}

const allAyahs = quranData.filter(
    (item) =>
        item &&
        typeof item === "object" &&
        item.text &&
        item.surah_name &&
        item.surah_number !== undefined &&
        item.ayat_no !== undefined
);

console.log(`Valid Quran records: ${allAyahs.length}`);

// ==================================================
// QUIZ QUESTIONS — in-memory
// ==================================================

const quizQuestions = new Map();
const QUIZ_TTL = 10 * 60 * 1000;

function cleanupExpiredQuizzes() {
    const now = Date.now();
    for (const [id, data] of quizQuestions.entries()) {
        if (now > data.expiresAt) {
            quizQuestions.delete(id);
        }
    }
}

setInterval(cleanupExpiredQuizzes, 5 * 60 * 1000);

// Config for every supported quiz type.
// field       -> which ayah field holds the correct answer
// numeric     -> whether the answer/options are numbers or strings
// question    -> the question text shown to the user
// metaKey     -> the key (if any) in the response "meta" block that would
//                leak the answer for this type, so it gets stripped out
const QUIZ_CONFIG = {
    surah_number: { field: "surah_number", numeric: true, question: "This Ayah belongs to which Surah? (number)", metaKey: null },
    surah_name: { field: "surah_name", numeric: false, question: "This Ayah belongs to which Surah?", metaKey: "surahName" },
    para: { field: "para", numeric: true, question: "This Ayah belongs to which Para?", metaKey: "para" },
    page: { field: "page", numeric: true, question: "This Ayah belongs to which Page?", metaKey: "page" },
    pip: { field: "pip", numeric: true, question: "This Ayah belongs to which PIP?", metaKey: "pip" }
};

const QUIZ_TYPES = Object.keys(QUIZ_CONFIG);

// Builds 4 unique options (1 correct + 3 distractors) pulled from real
// ayah data — no fake/made-up values, ever.
function buildQuizOptions(config, correctValue) {
    const options = [correctValue];
    const seen = new Set([config.numeric ? correctValue : normalize(correctValue)]);

    let attempts = 0;
    while (options.length < 4 && attempts < 1000) {
        attempts++;
        const randomAyah = allAyahs[Math.floor(Math.random() * allAyahs.length)];
        const raw = randomAyah[config.field];

        if (raw === undefined || raw === null) continue;

        const candidate = config.numeric ? Number(raw) : String(raw);
        const key = config.numeric ? candidate : normalize(candidate);

        if (seen.has(key)) continue;

        seen.add(key);
        options.push(candidate);
    }

    return options.sort(() => Math.random() - 0.5);
}

// Generates a single quiz question of the given type, stores it in
// quizQuestions (with its type, for correct answer-checking later),
// and returns the payload to send to the client.
function generateQuizQuestion(type) {
    const config = QUIZ_CONFIG[type];
    const ayah = allAyahs[Math.floor(Math.random() * allAyahs.length)];
    const rawValue = ayah[config.field];
    const correct = config.numeric ? Number(rawValue) : rawValue;
    const options = buildQuizOptions(config, correct);
    const questionId = crypto.randomBytes(16).toString("hex");

    quizQuestions.set(questionId, {
        type,
        correct,
        expiresAt: Date.now() + QUIZ_TTL
    });

    const meta = {
        ayatNo: ayah.ayat_no,
        surahName: ayah.surah_name,
        page: ayah.page,
        para: ayah.para,
        pip: ayah.pip
    };

    if (config.metaKey) {
        delete meta[config.metaKey];
    }

    return {
        questionId,
        type,
        question: config.question,
        ayah: ayah.text,
        ...meta,
        options
    };
}

// ==================================================
// HELPERS
// ==================================================

function generateApiKey() {
    return PREFIX + crypto.randomBytes(32).toString("hex");
}

function getClientIP(req) {
    return (
        req.headers["cf-connecting-ip"] ||
        req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
        req.socket.remoteAddress ||
        "unknown"
    );
}

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

// ==================================================
// FIREBASE LOGIN MIDDLEWARE (only for /api/key)
// ==================================================

async function requireFirebaseLogin(req, res, next) {
    if (!firebaseReady) {
        return res.status(500).json({
            success: false,
            error: "Login is not configured on the server yet."
        });
    }

    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            error: "Sign in required. Send your Firebase ID token as a Bearer token."
        });
    }

    const idToken = authorization.slice(7).trim();

    try {
        const decoded = await admin.auth().verifyIdToken(idToken);

        req.firebaseUser = {
            uid: decoded.uid,
            email: decoded.email || "unknown",
            provider: decoded.firebase?.sign_in_provider || "unknown"
        };

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: "Invalid or expired sign-in session. Please sign in again."
        });
    }
}

// ==================================================
// API KEY AUTH MIDDLEWARE
// ==================================================

async function requireApiKey(req, res, next) {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            error: "API key required."
        });
    }

    const key = authorization.slice(7).trim();

    try {
        const data = await ApiKey.findOne({ key });

        if (!data) {
            return res.status(401).json({
                success: false,
                error: "Invalid or expired API key."
            });
        }

        if (data.revoked) {
            return res.status(401).json({
                success: false,
                error: "API key has been revoked."
            });
        }

        if (data.expiresAt && Date.now() > data.expiresAt.getTime()) {
            return res.status(401).json({
                success: false,
                error: "API key expired."
            });
        }

        if (data.requests >= MAX_REQUESTS_PER_KEY) {
            return res.status(429).json({
                success: false,
                error: "API request limit reached."
            });
        }

        data.requests += 1;
        await data.save();

        req.apiKeyData = data;
        next();
    } catch (error) {
        console.error("Auth middleware error:", error.message);
        return res.status(500).json({
            success: false,
            error: "Internal server error during authentication."
        });
    }
}

// ==================================================
// ADMIN AUTH MIDDLEWARE (chains after requireFirebaseLogin)
// ==================================================

function requireAdmin(req, res, next) {
    const email = normalize(req.firebaseUser?.email);

    if (!ADMIN_EMAILS.length) {
        return res.status(500).json({
            success: false,
            error: "No admin emails configured on the server (ADMIN_EMAILS)."
        });
    }

    if (!email || !ADMIN_EMAILS.includes(email)) {
        return res.status(403).json({
            success: false,
            error: "You do not have admin access."
        });
    }

    next();
}

// ==================================================
// HOME
// ==================================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ==================================================
// HEALTH
// ==================================================

app.get("/health", async (req, res) => {
    let activeKeys = 0;
    let totalUsers = 0;
    let dbStatus = "disconnected";

    try {
        activeKeys = await ApiKey.countDocuments();
        totalUsers = await User.countDocuments();
        dbStatus = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
    } catch (error) {
        dbStatus = "error";
    }

    res.json({
        success: true,
        status: "ok",
        records: allAyahs.length,
        activeKeys,
        totalUsers,
        dbStatus,
        firebaseReady,
        uptime: Math.floor(process.uptime()),
        serverTime: new Date().toISOString()
    });
});

// ==================================================
// GENERATE API KEY — requires Firebase login
// ==================================================

app.post("/api/key", requireFirebaseLogin, async (req, res) => {
    const ip = getClientIP(req);
    const { uid, email, provider } = req.firebaseUser;

    const rawName = String(req.body?.name || "").trim();
    const name = rawName ? rawName.slice(0, 60) : "Unnamed key";

    const expiresInKey = req.body?.expiresIn;
    if (!expiresInKey || !(expiresInKey in EXPIRATION_OPTIONS)) {
        return res.status(400).json({
            success: false,
            error: "Invalid expiration option. Use one of: " + Object.keys(EXPIRATION_OPTIONS).join(", ")
        });
    }

    const hours = EXPIRATION_OPTIONS[expiresInKey];

    try {
        const existingUser = await User.findOne({ uid });
        if (existingUser?.blocked) {
            return res.status(403).json({
                success: false,
                error: "This account has been blocked from generating API keys."
            });
        }

        const ipCount = await ApiKey.countDocuments({ ip, revoked: false });

        if (ipCount >= MAX_KEYS_PER_IP) {
            return res.status(429).json({
                success: false,
                error: "API key limit reached for this network."
            });
        }

        const userKeyCount = await ApiKey.countDocuments({ uid, revoked: false });

        if (userKeyCount >= MAX_KEYS_PER_USER) {
            return res.status(429).json({
                success: false,
                error: "API key limit reached for this account."
            });
        }

        const apiKey = generateApiKey();
        const now = Date.now();
        const expiresAt = hours === null ? null : new Date(now + hours * 60 * 60 * 1000);

        const created = await ApiKey.create({
            key: apiKey,
            name,
            ip,
            email,
            uid,
            createdAt: new Date(now),
            expiresAt,
            requests: 0
        });

        await User.findOneAndUpdate(
            { uid },
            {
                $set: { email, provider, lastSeenAt: new Date() },
                $setOnInsert: { firstSeenAt: new Date() },
                $inc: { totalKeysGenerated: 1 }
            },
            { upsert: true }
        );

        res.json({
            success: true,
            apiKey,
            id: created._id,
            name,
            expiresAt,
            maxRequests: MAX_REQUESTS_PER_KEY
        });
    } catch (error) {
        console.error("Key generation error:", error.message);
        res.status(500).json({
            success: false,
            error: "Failed to generate API key."
        });
    }
});

// ==================================================
// LIST MY KEYS
// ==================================================

app.get("/api/keys", requireFirebaseLogin, async (req, res) => {
    const { uid } = req.firebaseUser;

    try {
        const keys = await ApiKey.find({ uid })
            .sort({ createdAt: -1 })
            .select("name createdAt expiresAt requests revoked key");

        // Mask the key — only show a preview, not the full secret, once it has been created
        const masked = keys.map((k) => ({
            id: k._id,
            name: k.name,
            createdAt: k.createdAt,
            expiresAt: k.expiresAt,
            requests: k.requests,
            maxRequests: MAX_REQUESTS_PER_KEY,
            revoked: k.revoked,
            expired: k.expiresAt ? Date.now() > k.expiresAt.getTime() : false,
            keyPreview: k.key.slice(0, 22) + "…" + k.key.slice(-4)
        }));

        res.json({ success: true, keys: masked });
    } catch (error) {
        console.error("List keys error:", error.message);
        res.status(500).json({ success: false, error: "Failed to load keys." });
    }
});

// ==================================================
// REVOKE / DELETE A KEY
// ==================================================

app.delete("/api/key/:id", requireFirebaseLogin, async (req, res) => {
    const { uid } = req.firebaseUser;
    const { id } = req.params;

    try {
        const key = await ApiKey.findOne({ _id: id, uid });

        if (!key) {
            return res.status(404).json({
                success: false,
                error: "Key not found or does not belong to this account."
            });
        }

        await ApiKey.deleteOne({ _id: id });

        res.json({ success: true, message: "Key revoked." });
    } catch (error) {
        console.error("Revoke key error:", error.message);
        res.status(500).json({ success: false, error: "Failed to revoke key." });
    }
});

// ==================================================
// VALIDATE API KEY
// ==================================================

app.get("/api/validate", requireApiKey, (req, res) => {
    res.json({
        success: true,
        valid: true,
        message: "API key verified.",
        requestsUsed: req.apiKeyData.requests,
        requestsRemaining: MAX_REQUESTS_PER_KEY - req.apiKeyData.requests
    });
});

// ==================================================
// TEST API
// ==================================================

app.get("/api/test", requireApiKey, (req, res) => {
    res.json({
        success: true,
        message: "API key is valid.",
        requestsUsed: req.apiKeyData.requests,
        requestsRemaining: MAX_REQUESTS_PER_KEY - req.apiKeyData.requests,
        serverTime: new Date().toISOString()
    });
});

// ==================================================
// EXACT SURAH + AYAH
// ==================================================

app.get("/api/quran/:surah/:ayah", requireApiKey, (req, res) => {
    const surah = Number(req.params.surah);
    const ayah = Number(req.params.ayah);

    if (!Number.isInteger(surah) || !Number.isInteger(ayah)) {
        return res.status(400).json({ success: false, error: "Invalid surah or ayah number." });
    }

    const result = allAyahs.find(
        (item) => Number(item.surah_number) === surah && Number(item.ayat_no) === ayah
    );

    if (!result) {
        return res.status(404).json({ success: false, error: "Ayah not found." });
    }

    res.json({ success: true, data: result });
});

// ==================================================
// SURAH (ALL AYAHS)
// ==================================================

app.get("/api/quran/surah/:surah", requireApiKey, (req, res) => {
    const surah = Number(req.params.surah);

    if (!Number.isInteger(surah)) {
        return res.status(400).json({ success: false, error: "Invalid surah number." });
    }

    const results = allAyahs.filter((item) => Number(item.surah_number) === surah);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "Surah not found." });
    }

    res.json({ success: true, surah, count: results.length, data: results });
});

// ==================================================
// SURAH BY NAME
// ==================================================

app.get("/api/quran/surah-name/:name", requireApiKey, (req, res) => {
    const name = normalize(req.params.name);

    const results = allAyahs.filter((item) => normalize(item.surah_name) === name);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "Surah not found." });
    }

    res.json({ success: true, surahName: req.params.name, count: results.length, data: results });
});

// ==================================================
// AYAT NUMBER (ACROSS QURAN)
// ==================================================

app.get("/api/quran/ayat/:ayah", requireApiKey, (req, res) => {
    const ayah = Number(req.params.ayah);

    if (!Number.isInteger(ayah)) {
        return res.status(400).json({ success: false, error: "Invalid ayah number." });
    }

    const results = allAyahs.filter((item) => Number(item.ayat_no) === ayah);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "Ayah number not found." });
    }

    res.json({ success: true, ayah, count: results.length, data: results });
});

// ==================================================
// PARA
// ==================================================

app.get("/api/quran/para/:para", requireApiKey, (req, res) => {
    const para = Number(req.params.para);

    if (!Number.isInteger(para) || para < 1 || para > 30) {
        return res.status(400).json({ success: false, error: "Invalid para number." });
    }

    const results = allAyahs.filter((item) => Number(item.para) === para);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "Para not found." });
    }

    res.json({ success: true, para, count: results.length, data: results });
});

// ==================================================
// PAGE
// ==================================================

app.get("/api/quran/page/:page", requireApiKey, (req, res) => {
    const page = Number(req.params.page);

    if (!Number.isInteger(page) || page < 1) {
        return res.status(400).json({ success: false, error: "Invalid page number." });
    }

    const results = allAyahs.filter((item) => Number(item.page) === page);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "Page not found." });
    }

    res.json({ success: true, page, count: results.length, data: results });
});

// ==================================================
// PIP
// ==================================================

app.get("/api/quran/pip/:pip", requireApiKey, (req, res) => {
    const pip = Number(req.params.pip);

    if (!Number.isInteger(pip)) {
        return res.status(400).json({ success: false, error: "Invalid PIP value." });
    }

    const results = allAyahs.filter((item) => Number(item.pip) === pip);

    if (!results.length) {
        return res.status(404).json({ success: false, error: "PIP value not found." });
    }

    res.json({ success: true, pip, count: results.length, data: results });
});

// ==================================================
// TEXT / WORD SEARCH
// ==================================================

app.get("/api/quran/search", requireApiKey, (req, res) => {
    const query = normalize(req.query.q);

    if (!query) {
        return res.status(400).json({ success: false, error: "Search query is required." });
    }

    const results = allAyahs
        .filter((item) => normalize(item.text).includes(query))
        .slice(0, 100);

    res.json({ success: true, query, count: results.length, data: results });
});

// ==================================================
// QUIZ QUESTION
// ==================================================

app.get("/api/quiz/question", requireApiKey, (req, res) => {
    if (!allAyahs.length) {
        return res.status(500).json({ success: false, error: "No Quran data available." });
    }

    const typeParam = req.query.type;

    // Single-type mode: ?type=surah_number / surah_name / para / page / pip
    if (typeParam) {
        const type = normalize(typeParam);

        if (!QUIZ_TYPES.includes(type)) {
            return res.status(400).json({
                success: false,
                error: `Invalid type. Must be one of: ${QUIZ_TYPES.join(", ")}`
            });
        }

        return res.json({
            success: true,
            ...generateQuizQuestion(type)
        });
    }

    // Default mode (no type given): 3 questions — para + pip (mandatory)
    // and one random optional type from surah_number / surah_name / page.
    const OPTIONAL_TYPES = ["surah_number", "surah_name", "page"];
    const optionalType = OPTIONAL_TYPES[Math.floor(Math.random() * OPTIONAL_TYPES.length)];

    const questions = [
        generateQuizQuestion("para"),
        generateQuizQuestion("pip"),
        generateQuizQuestion(optionalType)
    ];

    res.json({
        success: true,
        questions
    });
});

// ==================================================
// CHECK QUIZ ANSWER
// ==================================================

app.post("/api/quiz/answer", requireApiKey, (req, res) => {
    const { questionId, answer } = req.body;

    if (!questionId) {
        return res.status(400).json({ success: false, error: "Question ID is required." });
    }

    const questionData = quizQuestions.get(questionId);

    if (!questionData) {
        return res.status(400).json({ success: false, error: "Question expired or not found." });
    }

    quizQuestions.delete(questionId);

    const isNameType = questionData.type === "surah_name";

    const userAnswer = isNameType ? String(answer || "") : Number(answer);
    const isCorrect = isNameType
        ? normalize(userAnswer) === normalize(questionData.correct)
        : userAnswer === questionData.correct;

    res.json({
        success: true,
        type: questionData.type,
        correct: isCorrect,
        userAnswer,
        correctAnswer: questionData.correct,
        message: isCorrect ? "Correct answer!" : "Wrong answer."
    });
});

// ==================================================
// ADMIN — OVERVIEW STATS
// ==================================================

app.get("/api/admin/overview", requireFirebaseLogin, requireAdmin, async (req, res) => {
    try {
        const now = new Date();

        const [
            totalUsers,
            blockedUsers,
            totalKeys,
            revokedKeys,
            expiredKeys,
            requestAgg
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ blocked: true }),
            ApiKey.countDocuments(),
            ApiKey.countDocuments({ revoked: true }),
            ApiKey.countDocuments({ revoked: false, expiresAt: { $ne: null, $lte: now } }),
            ApiKey.aggregate([{ $group: { _id: null, total: { $sum: "$requests" } } }])
        ]);

        const activeKeys = totalKeys - revokedKeys - expiredKeys;
        const totalRequests = requestAgg[0]?.total || 0;

        res.json({
            success: true,
            totalUsers,
            blockedUsers,
            totalKeys,
            activeKeys,
            revokedKeys,
            expiredKeys,
            totalRequests,
            quranRecords: allAyahs.length,
            dbStatus: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
            firebaseReady,
            uptime: Math.floor(process.uptime()),
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        console.error("Admin overview error:", error.message);
        res.status(500).json({ success: false, error: "Failed to load overview." });
    }
});

// ==================================================
// ADMIN — LIST ALL USERS (with per-user key/usage totals)
// ==================================================

app.get("/api/admin/users", requireFirebaseLogin, requireAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ lastSeenAt: -1 }).lean();

        const perUser = await ApiKey.aggregate([
            {
                $group: {
                    _id: "$uid",
                    keyCount: { $sum: 1 },
                    activeKeyCount: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$revoked", false] },
                                        {
                                            $or: [
                                                { $eq: ["$expiresAt", null] },
                                                { $gt: ["$expiresAt", new Date()] }
                                            ]
                                        }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    },
                    totalRequests: { $sum: "$requests" }
                }
            }
        ]);

        const statsByUid = new Map(perUser.map((u) => [u._id, u]));

        const result = users.map((u) => {
            const stats = statsByUid.get(u.uid) || { keyCount: 0, activeKeyCount: 0, totalRequests: 0 };
            return {
                uid: u.uid,
                email: u.email,
                provider: u.provider,
                firstSeenAt: u.firstSeenAt,
                lastSeenAt: u.lastSeenAt,
                totalKeysGenerated: u.totalKeysGenerated,
                blocked: !!u.blocked,
                keyCount: stats.keyCount,
                activeKeyCount: stats.activeKeyCount,
                totalRequests: stats.totalRequests
            };
        });

        res.json({ success: true, users: result });
    } catch (error) {
        console.error("Admin users list error:", error.message);
        res.status(500).json({ success: false, error: "Failed to load users." });
    }
});

// ==================================================
// ADMIN — BLOCK / UNBLOCK A USER
// ==================================================

app.patch("/api/admin/users/:uid/block", requireFirebaseLogin, requireAdmin, async (req, res) => {
    const { uid } = req.params;
    const blocked = !!req.body?.blocked;

    try {
        const user = await User.findOneAndUpdate({ uid }, { $set: { blocked } }, { new: true });

        if (!user) {
            return res.status(404).json({ success: false, error: "User not found." });
        }

        res.json({ success: true, uid, blocked: user.blocked });
    } catch (error) {
        console.error("Admin block user error:", error.message);
        res.status(500).json({ success: false, error: "Failed to update user." });
    }
});

// ==================================================
// ADMIN — LIST ALL API KEYS (every user)
// ==================================================

app.get("/api/admin/keys", requireFirebaseLogin, requireAdmin, async (req, res) => {
    const search = normalize(req.query.search);

    try {
        const query = search ? { email: { $regex: search, $options: "i" } } : {};

        const keys = await ApiKey.find(query).sort({ createdAt: -1 }).limit(500).lean();

        const now = Date.now();

        const result = keys.map((k) => ({
            id: k._id,
            name: k.name,
            email: k.email,
            uid: k.uid,
            ip: k.ip,
            createdAt: k.createdAt,
            expiresAt: k.expiresAt,
            requests: k.requests,
            maxRequests: MAX_REQUESTS_PER_KEY,
            revoked: k.revoked,
            expired: k.expiresAt ? now > new Date(k.expiresAt).getTime() : false,
            keyPreview: k.key.slice(0, 22) + "…" + k.key.slice(-4)
        }));

        res.json({ success: true, count: result.length, keys: result });
    } catch (error) {
        console.error("Admin keys list error:", error.message);
        res.status(500).json({ success: false, error: "Failed to load keys." });
    }
});

// ==================================================
// ADMIN — REVOKE ANY KEY (regardless of owner)
// ==================================================

app.delete("/api/admin/keys/:id", requireFirebaseLogin, requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const key = await ApiKey.findById(id);

        if (!key) {
            return res.status(404).json({ success: false, error: "Key not found." });
        }

        await ApiKey.deleteOne({ _id: id });

        res.json({ success: true, message: "Key revoked." });
    } catch (error) {
        console.error("Admin revoke key error:", error.message);
        res.status(500).json({ success: false, error: "Failed to revoke key." });
    }
});

// ==================================================
// 404
// ==================================================

app.use((req, res) => {
    res.status(404).json({ success: false, error: "Endpoint not found." });
});

// ==================================================
// START
// ==================================================

app.listen(PORT, HOST, () => {
    console.log("");
    console.log("======================================");
    console.log("        NAJEEF QURAN API V1");
    console.log("======================================");
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Valid records: ${allAyahs.length}`);
    console.log("");
    console.log("Available Quran endpoints:");
    console.log("GET /api/quran/:surah/:ayah");
    console.log("GET /api/quran/surah/:surah");
    console.log("GET /api/quran/surah-name/:name");
    console.log("GET /api/quran/ayat/:ayah");
    console.log("GET /api/quran/para/:para");
    console.log("GET /api/quran/page/:page");
    console.log("GET /api/quran/pip/:pip");
    console.log("GET /api/quran/search?q=...");
    console.log("");
    console.log("Admin endpoints (require ADMIN_EMAILS + Firebase login):");
    console.log("GET   /api/admin/overview");
    console.log("GET   /api/admin/users");
    console.log("PATCH /api/admin/users/:uid/block");
    console.log("GET   /api/admin/keys");
    console.log("DELETE /api/admin/keys/:id");
    console.log(`Configured admins: ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(", ") : "(none — set ADMIN_EMAILS)"}`);
    console.log("");
    console.log("Server is running...");
    console.log("");
});
