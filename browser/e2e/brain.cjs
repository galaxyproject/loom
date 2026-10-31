// That Orbit's brain answered the drive that just ran, from the tools its requests declared:
// run-all.sh runs this after every stub-backed drive, so a build that quietly boots something else
// fails the tier instead of passing on another brain's behaviour.
//
// Orbit's brain is known by a tool it declares under any grant, read-only included
// (galaxy_read_output), and by never declaring the browser brain's old ones.
const MARKS = { always: "galaxy_read_output", never: ["finish", "notebook_resume"] };

/** What is wrong with these prompts, or [] when they fit; null when nothing says. */
function grade(prompts) {
    const declared = prompts.filter((p) => Array.isArray(p.tools) && p.tools.length > 0);
    // A drive that never reaches the model (credentials, a frame check) says nothing either way.
    if (declared.length === 0) return null;
    const failures = [];
    if (!declared.some((p) => p.tools.includes(MARKS.always))) failures.push(`no request declared ${MARKS.always}`);
    for (const name of MARKS.never) {
        const at = declared.findIndex((p) => p.tools.includes(name));
        if (at >= 0) failures.push(`request ${at + 1} declared ${name}`);
    }
    return failures;
}

module.exports = { grade };

if (require.main === module) {
    const STUB = process.env.STUB || "http://127.0.0.1:8099";
    (async () => {
        const { prompts = [] } = await (await fetch(`${STUB}/__seen`)).json();
        const failures = grade(prompts);
        if (failures === null) {
            console.log("brain: no request declared tools; not checked");
        } else if (failures.length) {
            console.log(`brain: expected Orbit's, but ${failures.join("; ")}`);
            process.exit(1);
        } else {
            console.log("brain: orbit");
        }
    })().catch((error) => {
        console.error(`brain: ${error.message}`);
        process.exit(2);
    });
}
