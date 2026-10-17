export function activeModelBlock(options?: { model?: string; provider?: string }): string;
export function currentDateBlock(now?: Date, options?: { record?: string }): string;
export function parameterReviewBlock(options?: { approved?: string }): string;
export function sraImportGuidance(options?: {
  before?: string;
  record?: string;
  recording?: string;
}): string;
export function draftingAPlan(options?: {
  tool?: (name: string) => string;
  local?: boolean;
  resume?: string;
}): string;
export function chatFormatting(options?: { results?: string }): string;
export function galaxyTerminology(options?: {
  tool?: (name: string) => string;
  more?: string[];
  invocationNote?: string;
  routing?: boolean;
}): string;
export function artifactLinkGuidance(options?: {
  record?: string;
  blocks?: string;
  root?: string;
}): string;
export function noLocalShellBlock(options?: { tools?: string; instead?: string }): string;
export function galaxyUnavailableBlock(options?: { cause?: string; remedy?: string }): string;
export function gettingDataIn(options?: {
  tool?: (name: string) => string;
  staging?: string;
  accessions?: string;
  alternatives?: string[];
}): string;
export function galaxyPageMarkdown(options?: {
  tool?: (name: string) => string;
  heading?: string;
  artifacts?: string;
  offenders?: string;
}): string;
export function operatingDiscipline(options?: {
  record?: string;
  credentials?: string;
  mechanism?: string;
  realMechanism?: string;
  exists?: string;
  exportHint?: string;
}): string;
export function verificationBlock(options?: {
  record?: string;
  recordFile?: string;
  local?: boolean;
  runCheck?: string;
  await?: string;
  awaitJobs?: string;
  inspect?: string;
}): string;
export function recordWrites(options?: {
  tool?: (name: string) => string;
  heading?: string;
  record?: string;
  howToWrite?: string;
  editing?: string[];
  visibility?: string;
  writeVerb?: string;
  writeClaim?: string;
}): string;
export function planConvention(options?: {
  tool?: (name: string) => string;
  intro?: string;
  record?: string;
  recordFile?: string;
  writeVerb?: string;
  shell?: string;
  local?: boolean;
  omitAnchors?: boolean;
  override?: string;
  awaitRun?: string;
  anchor?: (id: string) => string;
  anchorGuidance?: string;
}): string;
export function executingAStep(options?: {
  record?: string;
  approval?: string;
  recording?: string;
  waiting?: string;
  tail?: string;
}): string;
