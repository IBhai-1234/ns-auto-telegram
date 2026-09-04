const fs = require("fs");
const https = require("https");

const API = "https://www.nationstates.net/cgi-bin/api.cgi";

const TGID = process.env.TGID;
const SECRET_KEY = process.env.SECRET_KEY;
const CLIENT_KEY = process.env.NS_CLIENT_KEY;

const USER_AGENT = "Slavstonia AutoTelegram Bot";
const STATE_FILE = "state.json";

const SEND_DELAY = 180000; // 3 minutes
const RETRIES = 3;

if (!TGID || !SECRET_KEY || !CLIENT_KEY) {
    console.error("Missing GitHub Secret.");
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
    let state = {};

    if (fs.existsSync(STATE_FILE)) {
        try {
            state = JSON.parse(
                fs.readFileSync(STATE_FILE, "utf8")
            );
        } catch {
            console.log("Creating fresh state.");
        }
    }

    state.initialized = state.initialized ?? false;
    state.lastHappeningID = Number(state.lastHappeningID || 0);
    state.seenNew = Array.isArray(state.seenNew)
        ? state.seenNew
        : [];
    state.processed = Array.isArray(state.processed)
        ? state.processed
        : [];
    state.queue = Array.isArray(state.queue)
        ? state.queue
        : [];
    state.lastSend = Number(state.lastSend || 0);

    return state;
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
                        const error = new Error(
                            `HTTP ${res.statusCode}: ${data}`
                        );

                        error.statusCode = res.statusCode;
                        reject(error);
                        return;
                    }

                    resolve(data);
                });
            }
        );

        req.setTimeout(30000, () => {
            req.destroy(
                new Error("Request timed out")
            );
        });

        req.on("error", reject);
    });
}

/* =========================
   NEWEST NATIONS
========================= */

async function getNewestNations() {
    const xml = await request({
        q: "newnations"
    });

    const match = xml.match(
        /<NEWNATIONS>([\s\S]*?)<\/NEWNATIONS>/i
    );

    if (!match) {
        console.log(
            "Could not find NEWNATIONS in API response."
        );

        console.log(xml);

        return [];
    }

    const nations = match[1]
        .split(",")
        .map(nation =>
            nation
                .trim()
                .replace(/^@@|@@$/g, "")
                .toLowerCase()
        )
        .filter(Boolean);

    return [...new Set(nations)].slice(0, 50);
}

/* =========================
   NEW WA NATIONS
========================= */

async function getNewWANations(state) {
    const xml = await request({
        q: "happenings",
        filter: "member",
        limit: "100",
        sinceid: String(state.lastHappeningID)
    });

    const nations = [];

    const eventRegex =
        /<EVENT[^>]*id="(\d+)"[^>]*>[\s\S]*?<TEXT>([\s\S]*?)<\/TEXT>[\s\S]*?<\/EVENT>/gi;

    let match;
    let highestID = state.lastHappeningID;

    while ((match = eventRegex.exec(xml)) !== null) {
        const id = Number(match[1]);

        if (id > highestID) {
            highestID = id;
        }

        const text = match[2]
            .replace(/<!\[CDATA\[|\]\]>/g, "")
            .replace(/<[^>]+>/g, "")
            .trim();

        const admitted = text.match(
            /(.+?) was admitted to the World Assembly\./i
        );

        if (admitted) {
            const nation = admitted[1]
                .trim()
                .replace(/^@@|@@$/g, "")
                .toLowerCase();

            if (nation) {
                nations.push(nation);
            }
        }
    }

    state.lastHappeningID = highestID;

    return [...new Set(nations)];
}

/* =========================
   QUEUE
========================= */

function addTarget(state, nation, reason) {
    nation = nation
        .toLowerCase()
        .replace(/^@@|@@$/g, "");

    if (!nation) return;

    if (state.processed.includes(nation)) {
        return;
    }

    if (
        state.queue.some(
            x => x.nation === nation
        )
    ) {
        return;
    }

    state.queue.push({
        nation,
        reason
    });

    console.log(
        `QUEUED: ${nation} (${reason})`
    );
}

/* =========================
   SEND TELEGRAM
========================= */

async function sendTG(nation) {
    console.log("");
    console.log(
        `========== SENDING TO ${nation} ==========`
    );

    for (
        let attempt = 1;
        attempt <= RETRIES;
        attempt++
    ) {
        try {
            const response = await request({
                a: "sendTG",
                client: CLIENT_KEY,
                tgid: TGID,
                key: SECRET_KEY,
                to: nation
            });

            console.log(
                "NationStates API response:"
            );

            console.log(response);

            if (/error/i.test(response)) {
                throw new Error(
                    `NationStates API error: ${response}`
                );
            }

            console.log(
                `SEND ACCEPTED: ${nation}`
            );

            return true;

        } catch (error) {
            console.log(
                `Attempt ${attempt}/${RETRIES} failed: ${error.message}`
            );

            if (attempt < RETRIES) {
                console.log(
                    "Waiting 60 seconds before retry..."
                );

                await sleep(60000);
            }
        }
    }

    return false;
}

/* =========================
   DISCOVER TARGETS
========================= */

async function discover(state) {

    console.log("");
    console.log(
        "===== NEWEST NATIONS ====="
    );

    const newest =
        await getNewestNations();

    console.log(
        `Found ${newest.length} newest nations.`
    );

    for (const nation of newest) {
        addTarget(
            state,
            nation,
            "newest nation"
        );
    }

    console.log("");
    console.log(
        "===== NEW WA NATIONS ====="
    );

    const newWA =
        await getNewWANations(state);

    console.log(
        `Found ${newWA.length} new WA nations.`
    );

    for (const nation of newWA) {
        addTarget(
            state,
            nation,
            "new WA nation"
        );
    }

    state.seenNew = newest;
    state.initialized = true;

    saveState(state);
}

/* =========================
   PROCESS QUEUE
========================= */

async function processQueue(state) {

    console.log("");

    console.log(
        `===== ${state.queue.length} TARGETS IN QUEUE =====`
    );

    while (state.queue.length > 0) {

        const target =
            state.queue[0];

        if (state.lastSend !== 0) {

            const elapsed =
                Date.now() -
                state.lastSend;

            if (elapsed < SEND_DELAY) {

                const remaining =
                    SEND_DELAY -
                    elapsed;

                console.log(
                    `Waiting ${Math.ceil(
                        remaining / 1000
                    )} seconds...`
                );

                await sleep(
                    remaining
                );
            }
        }

        const success =
            await sendTG(
                target.nation
            );

        if (!success) {

            console.log(
                `Keeping ${target.nation} in queue for the next run.`
            );

            saveState(state);

            process.exit(1);
        }

        state.queue.shift();

        if (
            !state.processed.includes(
                target.nation
            )
        ) {
            state.processed.push(
                target.nation
            );
        }

        state.lastSend =
            Date.now();

        saveState(state);

        console.log(
            `DONE: ${target.nation}`
        );
    }

    console.log("");
    console.log(
        "===== QUEUE EMPTY ====="
    );
}

/* =========================
   MAIN
========================= */

async function main() {

    console.log("");

    console.log(
        "===== SLAVSTONIA AUTOTELEGRAM ====="
    );

    const state =
        loadState();

    await discover(state);

    await processQueue(state);

    saveState(state);

    console.log(
        "===== RUN FINISHED ====="
    );
}

main().catch(error => {

    console.error(
        "FATAL ERROR:",
        error
    );

    process.exit(1);
});
