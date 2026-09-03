const fs = require("fs");
const https = require("https");

const API = "https://www.nationstates.net/cgi-bin/api.cgi";

const TGID = process.env.TGID;
const SECRET_KEY = process.env.SECRET_KEY;
const CLIENT_KEY = process.env.NS_CLIENT_KEY;

const USER_AGENT = "Slavstonia AutoTelegram Bot";

if (!TGID || !SECRET_KEY || !CLIENT_KEY) {
    console.error("ERROR: One or more GitHub Secrets are missing.");
    process.exit(1);
}

const STATE_FILE = "state.json";

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return {
            initialized: false,
            seenNew: [],
            seenWA: [],
            queue: [],
            lastSend: 0
        };
    }

    return JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
    );
}

function saveState(state) {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(state, null, 2)
    );
}

function request(params) {
    return new Promise((resolve, reject) => {
        const url = new URL(API);

        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const req = https.get(
            url,
            {
                headers: {
                    "User-Agent": USER_AGENT
                }
            },
            res => {
                let data = "";

                res.on("data", chunk => {
                    data += chunk;
                });

                res.on("end", () => {
                    if (res.statusCode >= 400) {
                        reject(
                            new Error(
                                `HTTP ${res.statusCode}: ${data}`
                            )
                        );
                        return;
                    }

                    resolve(data);
                });
            }
        );

        req.on("error", reject);
    });
}

function extractNationNames(xml) {
    const names = [];

    const regex =
        /<NATION[^>]*>([^<]+)<\/NATION>/gi;

    let match;

    while ((match = regex.exec(xml)) !== null) {
        names.push(
            match[1].trim().toLowerCase()
        );
    }

    return [...new Set(names)];
}

async function getNewNations() {
    const xml = await request({
        q: "newnations"
    });

    return extractNationNames(xml);
}

async function getWAMembers() {
    const xml = await request({
        wa: "1",
        q: "members"
    });

    return extractNationNames(xml);
}

function addToQueue(state, nation, reason) {
    nation = nation.toLowerCase();

    if (
        state.queue.some(
            item => item.nation === nation
        )
    ) {
        return;
    }

    state.queue.push({
        nation,
        reason
    });
}

async function sendTelegram(nation) {
    console.log(
        `Sending recruitment telegram to ${nation}...`
    );

    const result = await request({
        a: "sendTG",
        client: CLIENT_KEY,
        tgid: TGID,
        key: SECRET_KEY,
        to: nation
    });

    console.log("NationStates response:", result);
}

async function main() {
    const state = loadState();

    console.log("Checking newest nations...");
    const newNations = await getNewNations();

    console.log(
        `Found ${newNations.length} newest nations.`
    );

    console.log("Checking World Assembly members...");
    const waMembers = await getWAMembers();

    console.log(
        `Found ${waMembers.length} WA members.`
    );

    const oldNew = new Set(state.seenNew);
    const oldWA = new Set(state.seenWA);

    // First run: record the current lists.
    // This prevents messaging existing nations immediately.
    if (!state.initialized) {
        state.initialized = true;
        state.seenNew = newNations;
        state.seenWA = waMembers;

        saveState(state);

        console.log(
            "First run complete. Existing nations recorded."
        );

        return;
    }

    // Find newly created nations.
    for (const nation of newNations) {
        if (!oldNew.has(nation)) {
            addToQueue(
                state,
                nation,
                "new nation"
            );
        }
    }

    // Find newly joined WA nations.
    for (const nation of waMembers) {
        if (!oldWA.has(nation)) {
            addToQueue(
                state,
                nation,
                "new WA member"
            );
        }
    }

    state.seenNew = newNations;
    state.seenWA = waMembers;

    saveState(state);

    console.log(
        `Queue: ${state.queue.length} nations`
    );

    // Nothing to send.
    if (state.queue.length === 0) {
        console.log("Nothing to send.");
        return;
    }

    // NationStates recruitment TG limit:
    // one successful recruitment TG every 180 seconds.
    const elapsed =
        (Date.now() - state.lastSend) / 1000;

    if (elapsed < 180) {
        console.log(
            `Waiting for rate limit: ${Math.ceil(
                180 - elapsed
            )} seconds.`
        );

        return;
    }

    const target = state.queue[0];

    try {
        await sendTelegram(target.nation);

        state.queue.shift();
        state.lastSend = Date.now();

        saveState(state);

        console.log(
            `Successfully contacted ${target.nation}.`
        );
    } catch (error) {
        console.error(
            "Telegram failed:",
            error.message
        );

        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
