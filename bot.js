const fs = require("fs");
const https = require("https");

const API = "https://www.nationstates.net/cgi-bin/api.cgi";

const TGID = process.env.TGID;
const SECRET_KEY = process.env.SECRET_KEY;
const CLIENT_KEY = process.env.NS_CLIENT_KEY;

const USER_AGENT = "Slavstonia AutoTelegram Bot";

const STATE_FILE = "state.json";
const SEND_DELAY = 180000; // 3 minutes

if (!TGID || !SECRET_KEY || !CLIENT_KEY) {
    console.error("Missing GitHub Secret.");
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return {
            initialized: false,
            lastHappeningID: 0,
            seenNew: [],
            processed: [],
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

/* =========================
   NEWEST NATIONS
========================= */

async function getNewestNations() {
    const xml = await request({
        q: "newnations"
    });

    const nations = [];

    const regex =
        /<NATION[^>]*>([^<]+)<\/NATION>/gi;

    let match;

    while ((match = regex.exec(xml)) !== null) {
        nations.push(
            match[1].trim().toLowerCase()
        );
    }

    return [...new Set(nations)];
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
            nations.push(
                admitted[1]
                    .trim()
                    .toLowerCase()
            );
        }
    }

    state.lastHappeningID = highestID;

    return [...new Set(nations)];
}

/* =========================
   QUEUE
========================= */

function addTarget(state, nation, reason) {
    nation = nation.toLowerCase();

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

    const response = await request({
        a: "sendTG",
        client: CLIENT_KEY,
        tgid: TGID,
        key: SECRET_KEY,
        to: nation
    });

    console.log("NationStates API response:");
    console.log(response);

    return response;
}

/* =========================
   DISCOVER TARGETS
========================= */

async function discover(state) {
    console.log("");
    console.log("===== NEWEST NATIONS =====");

    const newest = await getNewestNations();

    console.log(
        `Found ${newest.length} newest nations.`
    );

    /*
     * IMPORTANT:
     * On the first run we WILL queue the
     * current newest nations.
     */
    for (const nation of newest) {
        addTarget(
            state,
            nation,
            "newest nation"
        );
    }

    console.log("");
    console.log("===== NEW WA NATIONS =====");

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
        const target = state.queue[0];

        if (state.lastSend !== 0) {
            const elapsed =
                Date.now() - state.lastSend;

            if (elapsed < SEND_DELAY) {
                const remaining =
                    SEND_DELAY - elapsed;

                console.log(
                    `Waiting ${Math.ceil(
                        remaining / 1000
                    )} seconds...`
                );

                await sleep(remaining);
            }
        }

        try {
            await sendTG(target.nation);

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

            state.lastSend = Date.now();

            saveState(state);

            console.log(
                `DONE: ${target.nation}`
            );

        } catch (error) {
            console.error(
                `FAILED: ${target.nation}`
            );

            console.error(error.message);

            saveState(state);

            process.exit(1);
        }
    }

    console.log("");
    console.log("===== QUEUE EMPTY =====");
}

/* =========================
   MAIN
========================= */

async function main() {
    console.log("");
    console.log(
        "===== SLAVSTONIA AUTOTELEGRAM ====="
    );

    const state = loadState();

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
