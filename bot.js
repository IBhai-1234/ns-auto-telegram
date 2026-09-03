const fs = require("fs");
const https = require("https");

const API = "https://www.nationstates.net/cgi-bin/api.cgi";

const TGID = process.env.TGID;
const SECRET_KEY = process.env.SECRET_KEY;
const CLIENT_KEY = process.env.NS_CLIENT_KEY;

const USER_AGENT = "Slavstonia AutoTelegram Bot";

const STATE_FILE = "state.json";
const SEND_DELAY = 180000; // 180 seconds

if (!TGID || !SECRET_KEY || !CLIENT_KEY) {
    console.error("ERROR: Missing GitHub Secret.");
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return {
            initialized: false,
            seenNew: [],
            seenWA: [],
            queue: [],
            sent: [],
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
        const nation = match[1]
            .trim()
            .toLowerCase();

        if (nation) {
            names.push(nation);
        }
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

    // Never contact the same nation twice.
    if (state.sent.includes(nation)) {
        return;
    }

    // Don't add duplicates to the queue.
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

    console.log(
        `Queued ${nation} (${reason})`
    );
}

async function sendTelegram(nation) {
    console.log(
        `Sending recruitment TG to ${nation}...`
    );

    const result = await request({
        a: "sendTG",
        client: CLIENT_KEY,
        tgid: TGID,
        key: SECRET_KEY,
        to: nation
    });

    console.log(
        `NationStates response: ${result}`
    );
}

async function discover(state) {
    console.log("Getting newest nations...");

    const newNations = await getNewNations();

    console.log(
        `Newest nations found: ${newNations.length}`
    );

    console.log("Getting WA members...");

    const waMembers = await getWAMembers();

    console.log(
        `WA members found: ${waMembers.length}`
    );

    const oldNew = new Set(state.seenNew);
    const oldWA = new Set(state.seenWA);

    // First run only records what's already there.
    if (!state.initialized) {
        state.initialized = true;
        state.seenNew = newNations;
        state.seenWA = waMembers;

        saveState(state);

        console.log(
            "First run complete."
        );

        console.log(
            "Existing nations were recorded, not contacted."
        );

        return;
    }

    // Newly appearing nations.
    for (const nation of newNations) {
        if (!oldNew.has(nation)) {
            addToQueue(
                state,
                nation,
                "new nation"
            );
        }
    }

    // Newly appearing WA members.
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
}

async function processQueue(state) {
    console.log(
        `Targets waiting: ${state.queue.length}`
    );

    while (state.queue.length > 0) {

        const target = state.queue[0];

        // Respect the 180-second recruitment limit.
        const elapsed =
            Date.now() - state.lastSend;

        if (
            state.lastSend !== 0 &&
            elapsed < SEND_DELAY
        ) {
            const remaining =
                SEND_DELAY - elapsed;

            console.log(
                `Waiting ${Math.ceil(
                    remaining / 1000
                )} seconds before next TG...`
            );

            await sleep(remaining);
        }

        try {
            await sendTelegram(
                target.nation
            );

            // Remove from queue.
            state.queue.shift();

            // Remember permanently that we contacted them.
            if (!state.sent.includes(target.nation)) {
                state.sent.push(target.nation);
            }

            state.lastSend = Date.now();

            saveState(state);

            console.log(
                `SUCCESS: ${target.nation}`
            );

            console.log(
                `Remaining queue: ${state.queue.length}`
            );

        } catch (error) {

            console.error(
                `FAILED: ${target.nation}`
            );

            console.error(
                error.message
            );

            // Keep the nation in the queue.
            // The next scheduled run can try again.
            saveState(state);

            process.exit(1);
        }
    }

    console.log(
        "Queue completely processed."
    );
}

async function main() {
    console.log(
        "===== NationStates AutoTelegram ====="
    );

    const state = loadState();

    await discover(state);

    await processQueue(state);

    saveState(state);

    console.log(
        "===== BOT FINISHED ====="
    );
}

main().catch(error => {
    console.error(
        "FATAL ERROR:",
        error.message
    );

    process.exit(1);
});
