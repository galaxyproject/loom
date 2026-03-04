# gxypi: structured agentic analysis for Galaxy

## The problem we've already proven exists

In our recent manuscript, we demonstrated that agentic AI can do real genomic analysis — variant characterization across 5,000+ *C. auris* surveillance samples, custom annotation of overlapping reading frames in measles virus, reproduction of a published RNA-seq experiment. The results held up. The biology was sound. The approach worked.

But the work also surfaced how easily things go wrong. In the course of preparing the manuscript, we encountered a case where the agent proposed matching genes between annotation versions by log2 fold-change correlation — it yielded an apparent R-squared of 0.9996 while only 1% of gene pairs were correctly matched. The error was invisible from output alone. It took deliberate, structured validation to catch it.

The paper ends with a set of guidelines that amount to: this is powerful, but you have to be disciplined about it. No vague prompts. Interact using files, not free text. Produce rerunnable artifacts. Save everything in version control. The problem is that following those guidelines currently requires a researcher to manually assemble the discipline — writing numbered STEP files in Markdown, managing API keys through keychains and environment variables, manually committing notebooks to git, and keeping track of which iteration of which analysis produced which result.

gxypi automates that discipline — plans, provenance, version control — so the researcher gets the structure without the manual overhead.

## How it works

A researcher starts gxypi in an empty directory and describes what they want to do: "I have RNA-seq data from a Pasilla knockdown experiment, I want to find differentially expressed genes." From that point, the tool imposes structure automatically.

**A plan, not a conversation.** The first thing gxypi does is create a formal analysis plan — a data structure with a research question, expected outcomes, and a phased step list. The difference between "do an RNA-seq analysis" (the kind of vague prompt the manuscript warns against) and a concrete, reviewable sequence of operations with dependencies and success criteria. The plan can evolve — steps get added, reordered, or skipped as the analysis develops — but every change is tracked. When a BRC Analytics catalog is available, organism, assembly, and workflow selections are tracked on the plan alongside everything else, so the full context of *what* is being analyzed and *with what* is part of the record from the start. Whether the researcher follows a rigid protocol or explores opportunistically, the record of what happened and why is the same.

**Phases that mirror how science actually works.** The plan moves through five lifecycle phases: problem definition, data acquisition, analysis, interpretation, publication. This isn't a rigid gate system — a researcher exploring a dataset might jump between phases, circle back from interpretation to try a different analysis, or skip problem definition entirely if they already know what they're looking for. The phases are there to *track* where you are, not to lock you in. But they shape the agent's behavior through tool descriptions and plan structure, making it more likely to follow a sensible sequence. And when you do deviate — when you skip ahead or backtrack — the phase transitions are logged, so the record shows what happened.

**Provenance from the start.** When data enters the system, gxypi tracks where it came from (GEO, SRA, local files), registers each sample with its condition and replicate number, logs each file with its type and pairing information, and links everything to Galaxy dataset IDs after import. This is exactly the kind of metadata bookkeeping that the RNA-seq case study in the manuscript required — where the agent had to triangulate four separate sources just to figure out which SRR accession mapped to which experimental condition. If that mapping had been captured at acquisition time, the downstream analysis would have been straightforward.

**Every decision recorded.** When the agent chooses a tool, picks parameters, evaluates QC results, or makes any analytical judgment, it logs a decision entry with a description, rationale, and whether the researcher approved it. This is the audit trail. It's what lets you answer "why did you use HISAT2 instead of STAR" or "what threshold did you use for DE genes and why" six months later when you're writing the paper or responding to reviewers.

**QC checkpoints.** At critical junctures — after quality control, after alignment, after differential expression — the agent creates a checkpoint with explicit pass/fail criteria and observations. The checkpoints don't hard-block the analysis; a researcher in exploratory mode might push past a marginal QC result to see what happens downstream. But the checkpoint is recorded either way, with its status and the observations that led to the decision. Six months later, when you're writing the paper, you can see exactly which QC checks passed, which were marginal, and what you decided to do about it.

**A notebook that's also a git history.** Everything above gets persisted to a markdown notebook file in the working directory — including BRC catalog context when present, so the organism, assembly, and workflow selections that shaped the analysis are part of the persisted record. The file isn't just saved — it's git-tracked. Every step completion, every QC checkpoint, every decision, every phase transition gets its own commit with a descriptive message. The result is that `git log` for an analysis directory reads like a lab notebook:

```
QC: Post-alignment QC (passed)
Step 3: completed
Log: parameter_choice
Add step: Differential Expression
Step 2: completed
QC: Raw read QC (passed)
Step 1: completed
Add step: Read Mapping
Add step: Quality Control
Phase: data_acquisition
Create analysis notebook
```

It directly addresses the manuscript's fourth guideline — "save all interactions with agentic tools per project ... the best approach is to save them in version control platforms such as GitHub." gxypi doesn't just recommend this; it does it automatically, on every meaningful change, without the researcher having to remember.

## Example: RNA-seq from scratch

To make this concrete, here's what a full analysis looks like in gxypi, based on the GTN "Reference-based RNA-Seq" tutorial — the Pasilla gene knockdown experiment in *Drosophila* (Brooks et al. 2011, 7 samples, data on Zenodo).

**Startup.** The researcher has `~/.gxypi/config.json` with their LLM provider and a Galaxy profile. They run `gxypi` in an empty directory. The tool reads the config, sets up the LLM, connects to Galaxy automatically, and asks what they'd like to work on.

**"I want to find differentially expressed genes after Pasilla knockdown in Drosophila. The data is on Zenodo."** From this, gxypi:

- Searches GTN for relevant tutorials to inform the analysis plan
- Creates a formal plan: "Pasilla RNA-seq differential expression," with a research question, data description, and expected outcomes (DE gene list, volcano plot, GO enrichment, KEGG pathways)
- Refines the research question into a testable hypothesis using the PICO framework (population: Drosophila S2 cells, intervention: Pasilla RNAi, comparison: untreated, outcome: DE genes)
- Adds the original Brooks et al. paper as a literature reference
- Auto-creates a notebook file in the working directory and commits it to git

**Data acquisition.** gxypi transitions to the data acquisition phase and registers everything:

- Data source: GEO (GSE18508)
- Seven samples with conditions (4 untreated, 3 treated) and replicate numbers
- FASTQ files with read types (single-end vs. paired-end) and pairing information
- After importing into Galaxy, each file gets linked to its Galaxy dataset ID

All of this is tracked in the notebook and committed. If someone later asks "where did your data come from and how did you know which sample was which condition?" the answer is in the provenance record.

**Analysis.** The plan gets activated and the steps laid out:

1. Quality Control (Falco)
2. QC Aggregation (MultiQC)
3. Read Mapping (HISAT2)
4. Mapping QC (RSeQC)
5. Read Counting (featureCounts)
6. Differential Expression (DESeq2)
7. Visualization (volcano plot)
8. GO Enrichment (GOseq)
9. Pathway Analysis (pathview)

For each step, the same cycle plays out. The agent marks the step as in progress, runs the Galaxy tool, logs any parameter choices with rationale ("Using Falco instead of FastQC for speed — equivalent reports, 2-5x faster"), creates a QC checkpoint with criteria and observations ("All samples >Q30 median, minor adapter in PE samples, duplication 15-25%"), and marks the step complete with its outputs. Each of these actions is a git commit.

At step 6 (DESeq2), the agent logs the decision to use padj < 0.05 and |log2FC| > 1 as thresholds, with the rationale that these are standard starting points. The QC checkpoint records: 694 DE genes, PCA cleanly separates conditions, MA plot looks symmetric. The researcher reviews and approves, or asks to try different thresholds — either way, the decision and its outcome are recorded.

**Publication.** After interpretation, gxypi transitions to the publication phase. It recommends figure types based on the analysis (QC summary, PCA, volcano, heatmap, pathway diagram), the researcher picks the ones they want, and each gets tracked as a figure spec with a status. The methods section is auto-generated from the completed steps — which tools were used, in what order, with what parameters. The researcher edits it, but the starting point is accurate because it's derived from the actual execution record, not from memory.

**What's left behind.** At the end, the working directory contains:

- A markdown notebook with the full analysis: research question, hypothesis, data provenance, step-by-step execution with parameters and outputs, decision log, QC checkpoints, Galaxy dataset links, and publication materials
- A git history with ~30 commits tracing the entire trajectory from "create analysis notebook" to "Publication: methods_generated"
- Galaxy histories with all the computational artifacts

The directory can be pushed to GitHub alongside the Galaxy history link — everything needed to review the analysis is in one place.

## Example: catalog-guided analysis

The RNA-seq example above assumes the researcher already knows their organism, their data source, and which tools to use. But many analyses start further back — a researcher knows their organism and their question, but not which reference assembly to use, which workflows are compatible, or where to find the input files those workflows need.

Suppose a researcher says: "I want to analyze gene expression in *Saccharomyces cerevisiae* under heat stress."

gxypi queries the BRC Analytics catalog via MCP tools — it calls `search_organisms` and finds the organism (taxonomy ID 559292), then calls `get_assemblies` to list available genome assemblies. The researcher picks the reference assembly (GCF_000146045.2). gxypi calls `get_compatible_workflows` filtered by ploidy and taxonomy, and the researcher selects an RNA-seq workflow. A `check_compatibility` call confirms the assembly and workflow are a valid combination.

Now the critical step: gxypi calls `resolve_workflow_inputs` with the chosen assembly and workflow. The BRC MCP server resolves the concrete inputs — reference FASTA URL, gene model annotation URL, dbkey — directly from the assembly accession. The researcher doesn't need to hunt through genome databases for the right file paths or figure out which annotation version matches their assembly. What the resolver *can't* fill in — the researcher's FASTQ data — is clearly identified as unresolved.

All of these selections are recorded on the analysis plan via `brc_set_context`, persisted in the notebook, and committed to git. From this point forward, the analysis proceeds exactly as before: data import, workflow invocation, QC checkpoints, interpretation. The catalog-guided setup is just a structured front-end to the same execution pipeline.

Without the catalog, a researcher would need to find the right assembly accession, locate the matching FASTA and GTF files, figure out the correct dbkey, and verify ploidy compatibility. The BRC MCP server handles that lookup, and gxypi records the selections so the provenance chain is intact from organism selection through final results.

## Why this structure matters

The manuscript identifies the core tension: agentic AI is powerful enough to do real science, but undisciplined use will deepen the reproducibility crisis. Web chat produces throwaway artifacts. Even proper agentic tools, used without structure, generate confident-but-wrong results that are hard to catch after the fact.

**Reviewability.** Every analysis has a plan that can be read before execution, a decision log that can be audited after execution, and a git history that shows the exact sequence of how you got from raw data to final result. A collaborator, reviewer, or the researcher themselves coming back six months later can reconstruct the entire analytical trajectory.

**Reproducibility.** The notebook contains everything needed to understand the analysis. The Galaxy histories contain the actual computational artifacts. The git repository connects the two with a timestamped record. Together, they create what the manuscript calls a "complete data-to-publication trajectory" — but as an automatic byproduct of doing the work, not as something you have to construct after the fact.

**Catchability.** The QC checkpoint system encourages evaluation of intermediate results. The decision log captures rationale at the moment choices are made. The phased structure gives the analysis a legible shape. None of this prevents the agent from making mistakes — our own experience with the gene-matching incident is a reminder of that — but it creates multiple natural points where mistakes can be caught, and a clear record of what was checked and what wasn't. Even in a freewheeling exploratory analysis, the checkpoints and decisions are there when you go back to verify.

**Iteration tracking.** The manuscript describes how "agent-generated results are usually imperfect" and "the user goes through a number of iterations that are explicitly recorded before the final, publishable result is obtained." gxypi's git tracking makes this automatic. Each iteration is a commit. You can diff between iterations. You can branch to try alternatives. You can revert when something goes wrong. The iterative refinement process that the manuscript identifies as essential is captured in the native language of version control.

## What changes

With the infrastructure from the manuscript and the structure from gxypi:

**A biologist who doesn't write code can run a publication-quality analysis.** Not by trusting the agent blindly — the plan review, QC checkpoints, and decision approval points keep the researcher in control — but by having the agent handle the mechanical parts (tool selection, parameter formatting, API calls, collection manipulation) while the researcher focuses on the biology. The *C. auris* surveillance study and the measles overlapping-frames study from the manuscript both involved substantial custom analysis that would normally require bioinformatics expertise. With gxypi's structure around it, the same kind of work becomes accessible to a researcher who can describe what they want in plain language and critically evaluate the results.

**Analyses become publishable artifacts.** The manuscript's guidelines end with a recommendation that publishers "ask for records of interactions with agentic AI tools." A gxypi analysis directory *is* that record. Push it to GitHub and you have: a readable notebook documenting the research question, data provenance, analytical steps, decisions, and results; a git history showing the exact sequence of operations; Galaxy history links to the computational artifacts. This is more complete than what most computational papers provide today, and it was generated as a side effect of doing the work.

**GTN tutorials become executable.** gxypi includes tools to search and fetch Galaxy Training Network tutorials. This means a researcher can say "I want to follow the reference-based RNA-seq tutorial but with my own data" and gxypi can pull the tutorial, build a plan from its steps, and execute them against a real Galaxy server with real data — with all the provenance tracking, QC checkpoints, and decision logging that a manual analysis would get. Training materials become templates for real analyses.

**The iterative refinement loop gets shorter.** The manuscript describes the analysis workflow as: write a plan, give it to the agent, evaluate the result, revise, repeat. Each cycle currently involves editing Markdown files, reviewing JupyterLite output, and manually tracking what changed. gxypi compresses this by making the plan a live data structure that the agent updates as it works, with automatic persistence and git tracking. The researcher's job narrows to the parts that actually require human judgment: reviewing QC results, approving decisions, and evaluating biological plausibility.

**Catalog-guided workflow discovery.** The BRC Analytics catalog covers a broad range of organisms and genome assemblies, with curated information about which analysis workflows are compatible with each. When a researcher names an organism, gxypi queries the catalog to find compatible workflows, check for issues (ploidy mismatches, missing gene annotations), and pre-fill workflow parameters. The researcher doesn't need to know that RNA-seq requires a reference FASTA and GTF — the catalog resolves those from the assembly accession. The researcher doesn't need to understand Galaxy's workflow system or know what inputs a pipeline requires — naming the organism and describing the question is enough to get started.

**Public data discovery.** The catalog integration includes ENA (European Nucleotide Archive) search — given an organism, the system can find publicly available sequencing datasets before the researcher commits to generating new data.

**Multi-server and multi-model flexibility.** The consolidated config file makes it trivial to switch between Galaxy servers (usegalaxy.org for production, test.galaxyproject.org for development, a local instance for sensitive data) and between LLM providers (commercial APIs for capability, local models for cost or privacy). This matters because the manuscript's approach currently requires CLI setup for each combination. gxypi reduces it to editing one JSON file.

## Where this is going

The manuscript ends by noting that "we anticipate these barriers diminishing as open-weight models improve and Galaxy integrates AI agents directly into its web interface, eliminating CLI requirements and payment barriers." Until then, gxypi provides that structure outside the Galaxy interface. It takes the approach proven in the manuscript — structured plans, Galaxy computation, versioned artifacts — and makes it accessible without requiring the researcher to manually assemble the pieces. When Galaxy's native agent integration arrives, the same structural ideas (plans, checkpoints, decision logs, provenance tracking) will still matter. The discipline doesn't go away just because the interface gets easier.

The BRC catalog integration demonstrates a broader pattern: specialized MCP servers expose domain knowledge, and gxypi consumes it to guide the researcher. The same pattern could extend to other resources — PubMed for literature context, UniProt for protein annotation, Ensembl for comparative genomics. Each new MCP server expands what the agent can discover and pre-configure, without gxypi needing to reimplement any of that domain knowledge.

The three case studies in the manuscript — surveillance genomics at scale, custom tool development for edge-case biology, reproduction of published experiments — represent exactly the kinds of work that benefit from this structure. They're complex enough that an unsupervised agent would make mistakes, important enough that those mistakes matter, and methodical enough that a structured plan can guide the work.