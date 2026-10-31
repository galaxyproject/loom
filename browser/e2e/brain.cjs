// Which brain answered the drive that just ran, from the tools its requests declared: run-all.sh
// runs this after every stub-backed drive, so a flag build that quietly boots the default brain
// (or the reverse) fails the tier instead of passing on the old brain's behaviour.
//
// EXPECT_BRAIN=browser (the default) or orbit. Each brain is known by a tool it declares under any
// grant, read-only included: Orbit's galaxy_read_output and the browser brain's finish. Neither
// declares the other's tools, record writers included.
const MARKS = {
    orbit: { always: "galaxy_read_output", never: ["finish", "notebook_resume"] },
    browser: { always: "finish", never: ["galaxy_read_output", "galaxy_job_record"] },
};

/** What is wrong with these prompts for `expected`, or [] when they fit; null when nothing says. */
function grade(prompts, expected) {
    const marks = MARKS[expected];
    if (!marks) throw new Error(`EXPECT_BRAIN must be browser or orbit, not ${JSON.stringify(expected)}`);
    const declared = prompts.filter((p) => Array.isArray(p.tools) && p.tools.length > 0);
    // A drive that never reaches the model (credentials, a frame check) says nothing either way.
    if (declared.length === 0) return null;
    const failures = [];
    if (!declared.some((p) => p.tools.includes(marks.always))) failures.push(`no request declared ${marks.always}`);
    for (const name of marks.never) {
        const at = declared.findIndex((p) => p.tools.includes(name));
        if (at >= 0) failures.push(`request ${at + 1} declared ${name}`);
    }
    return failures;
}

module.exports = { grade };

if (require.main === module) {
    const STUB = process.env.STUB || "http://127.0.0.1:8099";
    const expected = process.env.EXPECT_BRAIN || "browser";
    (async () => {
        const { prompts = [] } = await (await fetch(`${STUB}/__seen`)).json();
        const failures = grade(prompts, expected);
        if (failures === null) {
            console.log(`brain: no request declared tools; ${expected} not checked`);
        } else if (failures.length) {
            console.log(`brain: expected ${expected}, but ${failures.join("; ")}`);
            process.exit(1);
        } else {
            console.log(`brain: ${expected}`);
        }
    })().catch((error) => {
        console.error(`brain: ${error.message}`);
        process.exit(2);
    });
}
