export type SchemaTone = "primary" | "secondary" | "accent" | "info" | "success" | "warning" | "error" | "text" | "muted";

export interface SchemaSpan {
  text: string;
  tone?: SchemaTone;
  bold?: boolean;
}

export interface SchemaLine {
  spans: SchemaSpan[];
}

const MAX_LINES = 400;
const CLIP = 150;

const clip = (value: unknown, limit = CLIP): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

const t = (text: string, tone?: SchemaTone, bold?: boolean): SchemaSpan => ({ text, tone, bold });
const dim = (text: string): SchemaSpan => ({ text, tone: "muted" });
const badge = (label: string, tone: SchemaTone): SchemaSpan => t(`[${label}]`, tone, true);
const L = (...spans: SchemaSpan[]): SchemaLine => ({ spans });

const asArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asNumbers = (value: unknown): number[] => Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
const asObject = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const str = (value: unknown): string => typeof value === "string" ? value : "";

const KIND_TONE: Record<string, SchemaTone> = { refutes: "error", excludes: "warning", requires: "info", supports: "success", equivalent: "accent", acceptance: "primary", permission: "secondary" };

function section(lines: SchemaLine[], title: string, count?: number): void {
  if (count !== undefined && count <= 0) return;
  lines.push(L(t(count !== undefined ? `${title} (${count})` : title, "muted", true)));
}

function moreLines(lines: SchemaLine[], omitted: number, what: string): void {
  if (omitted > 0) lines.push(L(dim(`  ⋮ ${omitted} more ${what}`)));
}

function evidenceLines(lines: SchemaLine[], items: unknown): void {
  const facts = asArray(items);
  section(lines, "EVIDENCE", facts.length);
  for (const fact of facts.slice(0, 8)) lines.push(L(t(`  ● ${clip(fact.text)}`, "info"), dim(`  · ${clip(fact.source, 60)}${fact.kind ? ` · ${String(fact.kind).toUpperCase()}` : ""}`)));
  moreLines(lines, Math.max(0, facts.length - 8), "facts");
}

function handoffLines(lines: SchemaLine[], items: unknown): void {
  const requests = asArray(items);
  section(lines, "HANDOFF", requests.length);
  for (const request of requests.slice(0, 8)) {
    const where = [str(request.capability), str(request.regionId)].filter(Boolean).join(" ");
    lines.push(L(t(`  → ${clip(where || "helper", 40)}`, "secondary"), dim(`  · ${clip(request.request || request.expectedDelta, 90)}`)));
  }
  moreLines(lines, Math.max(0, requests.length - 8), "handoffs");
}

const CANDIDATE_BADGE: Record<string, { glyph: string; label: string; tone: SchemaTone }> = {
  selected: { glyph: "◆", label: "CHOSEN", tone: "success" },
  eliminated: { glyph: "×", label: "REJECTED", tone: "error" },
  equivalent: { glyph: "⇔", label: "EQUIVALENT", tone: "accent" },
  possible: { glyph: "◇", label: "POSSIBLE", tone: "text" },
};

function synthesisLines(value: Record<string, unknown>): SchemaLine[] {
  const lines: SchemaLine[] = [L(badge("SYNTHESIS DELTA", "accent"))];
  const region = asObject(value.region);
  if (region) {
    if (str(region.objective)) lines.push(L(t("GOAL ", "muted"), t(clip(region.objective))));
    if (str(region.delivery)) lines.push(L(t("DELIVERY ", "muted"), t(str(region.delivery) === "answer" ? "answer only" : "file changes")));
    for (const criterion of asStrings(region.acceptanceCriteria)) lines.push(L(t(`  ✓ ${clip(criterion)}`, "success")));
    if (asStrings(region.allowedVariables).length) lines.push(L(t("FREE CHOICES ", "muted"), t(asStrings(region.allowedVariables).map((choice) => clip(choice, 40)).join(" · "))));
  }
  evidenceLines(lines, value.evidence);
  const candidates = asArray(value.candidates);
  section(lines, "CANDIDATES", candidates.length);
  for (const candidate of candidates.slice(0, 10)) {
    const style = CANDIDATE_BADGE[str(candidate.outcome)] ?? CANDIDATE_BADGE.possible;
    lines.push(L(t(`  ${style.glyph} `, style.tone), badge(style.label, style.tone), t(` ${clip(candidate.proposition)}`)));
    const reasons = asStrings(candidate.reasons);
    if (reasons.length) lines.push(L(t(`      ↳ ${clip(reasons.join("; "))}`, "error")));
  }
  moreLines(lines, Math.max(0, candidates.length - 10), "candidates");
  const constraints = asArray(value.constraints);
  section(lines, "RELATIONSHIPS", constraints.length);
  for (const constraint of constraints.slice(0, 12)) {
    const kind = str(constraint.kind) || "related";
    lines.push(L(t("  "), badge(kind.toUpperCase(), KIND_TONE[kind] ?? "text"), t(` ${clip(constraint.subject, 40)} → ${clip(constraint.target, 40)}`), constraint.reason ? dim(`  · ${clip(constraint.reason)}`) : dim("")));
  }
  moreLines(lines, Math.max(0, constraints.length - 12), "relationships");
  const select = asStrings(value.select);
  if (select.length) lines.push(L(t("SELECTION ", "muted"), t(select.map((key) => clip(key, 40)).join(", "), "success", true)));
  const resolved = asObject(value.resolvedAnswer);
  if (resolved) {
    lines.push(L(t("ANSWER ", "muted"), t(clip(resolved.answer, 400), "success")));
    for (const criterion of asStrings(resolved.acceptanceCriteria)) lines.push(L(t(`  ✓ ${clip(criterion)}`, "success")));
  } else if (str(value.answer)) {
    lines.push(L(t("NOTE ", "muted"), t(clip(value.answer, 200))));
  }
  handoffLines(lines, value.activations);
  return lines;
}

function refinementLines(value: Record<string, unknown>): SchemaLine[] {
  const terminal = value.terminal === true;
  const contract = asObject(value.implementationContract);
  const children = asArray(value.children);
  const lines: SchemaLine[] = [L(badge("REFINEMENT", "accent"), terminal ? badge("CERTIFIED TERMINAL", "success") : badge(`SPLIT · ${children.length} CHILDREN`, "info"))];
  if (contract) {
    section(lines, "CONTRACT");
    for (const criterion of asStrings(contract.acceptanceCriteria)) lines.push(L(t(`  ✓ ${clip(criterion)}`, "success")));
    if (asStrings(contract.allowedVariables).length) lines.push(L(t("  FREE CHOICES ", "muted"), t(asStrings(contract.allowedVariables).map((choice) => clip(choice, 40)).join(" · "))));
    const covered = asNumbers(contract.coveredCriteria).map((index) => `#${String(index)}`);
    if (covered.length) lines.push(L(dim(`  COVERS ${covered.join(", ")}`)));
  }
  section(lines, "CHILDREN", children.length);
  for (const child of children.slice(0, 10)) {
    const refines = str(child.edge) !== "partOf";
    const coverage = asNumbers(child.coveredCriteria).map((index) => `#${String(index)}`).join(",");
    lines.push(L(t(`  ${refines ? "⌇" : "■"} `, refines ? "secondary" : "primary"), badge(refines ? "REFINES" : "PART OF", refines ? "secondary" : "primary"), t(` ${clip(child.objective)}`), coverage ? dim(`  · covers ${coverage}${child.key ? ` · ${clip(child.key, 24)}` : ""}`) : child.key ? dim(`  · ${clip(child.key, 24)}`) : dim("")));
  }
  moreLines(lines, Math.max(0, children.length - 10), "children");
  evidenceLines(lines, value.evidence);
  handoffLines(lines, value.activations);
  return lines;
}

function implementationLines(value: Record<string, unknown>): SchemaLine[] {
  const blocked = str(value.status) === "blocked";
  const lines: SchemaLine[] = [L(badge("IMPLEMENTATION", "primary"), blocked ? badge("BLOCKED", "warning") : badge("COMPLETED", "success"))];
  if (str(value.summary)) lines.push(L(dim(`  ${clip(value.summary, 200)}`)));
  const files = asStrings(value.changedFiles);
  section(lines, "FILES CHANGED", files.length);
  for (const file of files.slice(0, 12)) lines.push(L(t(`  + ${clip(file, 100)}`, "success")));
  moreLines(lines, Math.max(0, files.length - 12), "files");
  appendChecks(lines, value.checks);
  if (blocked && str(value.blocker)) lines.push(L(t("BLOCKER ", "muted"), t(clip(value.blocker, 250), "error")));
  handoffLines(lines, value.activations);
  return lines;
}

function appendChecks(lines: SchemaLine[], checks: unknown): void {
  const items = asArray(checks);
  section(lines, "CHECKS", items.length);
  for (const check of items.slice(0, 12)) {
    const passed = check.passed !== false;
    lines.push(L(t(`  ${passed ? "✓" : "✗"} ${clip(check.name, 48)}`, passed ? "success" : "error"), check.evidence ? dim(`  — ${clip(check.evidence)}`) : dim("")));
  }
  moreLines(lines, Math.max(0, items.length - 12), "checks");
}

const VERDICT_TONE: Record<string, SchemaTone> = { pass: "success", repair: "warning", reopen: "accent", fail: "error" };

function verificationLines(value: Record<string, unknown>): SchemaLine[] {
  const verdict = str(value.verdict) || "fail";
  const lines: SchemaLine[] = [L(badge("VERIFICATION", "info"), badge(verdict.toUpperCase(), VERDICT_TONE[verdict] ?? "warning"))];
  if (str(value.summary)) lines.push(L(dim(`  ${clip(value.summary, 200)}`)));
  appendChecks(lines, value.checks);
  const findings = asArray(value.findings);
  section(lines, "FINDINGS", findings.length);
  for (const finding of findings.slice(0, 10)) {
    lines.push(L(t(`  ! ${clip(finding.criterion, 64)}`, "warning"), finding.regionId ? dim(`  ${clip(finding.regionId, 16)}`) : dim("")));
    if (str(finding.problem)) lines.push(L(t(`      ${clip(finding.problem)}`, "text"), finding.evidence ? dim(`  — ${clip(finding.evidence)}`) : dim("")));
  }
  moreLines(lines, Math.max(0, findings.length - 10), "findings");
  handoffLines(lines, value.activations);
  return lines;
}

function presentationLines(value: Record<string, unknown>): SchemaLine[] {
  const lines: SchemaLine[] = [L(badge("ANSWER", "success"))];
  for (const paragraph of str(value.answer).split("\n").filter(Boolean).slice(0, 40)) lines.push(L(t(`  ${paragraph}`, "text")));
  return lines;
}

export function renderSchemaOutput(structured: unknown): SchemaLine[] | undefined {
  const value = asObject(structured);
  if (!value) return undefined;
  let lines: SchemaLine[] | undefined;
  if ("terminal" in value && ("children" in value || "implementationContract" in value)) lines = refinementLines(value);
  else if ("verdict" in value) lines = verificationLines(value);
  else if ("status" in value && ("changedFiles" in value || "checks" in value)) lines = implementationLines(value);
  else if ("candidates" in value || "select" in value || "resolvedAnswer" in value) lines = synthesisLines(value);
  else if (typeof value.answer === "string") lines = presentationLines(value);
  return lines ? lines.slice(0, MAX_LINES) : undefined;
}

const STATUS_STYLE: Record<string, { glyph: string; tone: SchemaTone }> = {
  chosen: { glyph: "◆", tone: "success" },
  rejected: { glyph: "×", tone: "error" },
  interchangeable: { glyph: "⇔", tone: "accent" },
  "still possible": { glyph: "◇", tone: "muted" },
};

export function renderSchemaInput(promptInput: string | undefined): SchemaLine[] | undefined {
  if (!promptInput) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(promptInput); } catch { return undefined; }
  const value = asObject(parsed);
  if (!value || typeof value.userRequest !== "string" || !(typeof value.yourAssignment === "string" || typeof value.goal === "string")) return undefined;
  const lines: SchemaLine[] = [L(badge("ACTIVATION INPUT", "primary"))];
  lines.push(L(t("REQUEST ", "muted"), t(clip(value.userRequest))));
  if (typeof value.yourAssignment === "string") lines.push(L(t("ASSIGNMENT ", "muted"), t(clip(value.yourAssignment), "text", true)));
  if (typeof value.goal === "string") lines.push(L(t("GOAL ", "muted"), t(clip(value.goal))));
  const focusLabels: Array<[string, unknown]> = [["QUESTION", value.questionToAnswer], ["CHOOSE", value.choiceToMake], ["SETTLE", value.approachToSettle], ["CHECK", value.changeToCheck], ["WRITE", value.answerToWrite]];
  for (const [label, focus] of focusLabels) if (typeof focus === "string") lines.push(L(t(`${label} `, "muted"), t(clip(focus), "accent", true)));
  if (value.mustNotChooseSolution === true) lines.push(L(badge("FACTS ONLY", "warning"), dim("  choosing a solution is not part of this assignment")));
  const criteria = asStrings(value.successCriteria);
  section(lines, "CRITERIA", criteria.length);
  for (const criterion of criteria.slice(0, 10)) lines.push(L(t(`  ✓ ${clip(criterion)}`, "success")));
  moreLines(lines, Math.max(0, criteria.length - 10), "criteria");
  if (asStrings(value.chooseOnly).length) lines.push(L(t("CHOOSE ONLY ", "muted"), t(asStrings(value.chooseOnly).map((choice) => clip(choice, 40)).join(" · "), "accent")));
  const facts = asArray(value.facts);
  section(lines, "FACTS", facts.length);
  for (const fact of facts.slice(0, 8)) lines.push(L(t(`  ● ${clip(fact.fact)}`, "info"), dim(`  · ${clip(fact.referenceId, 12)} · ${clip(fact.source, 50)}`)));
  moreLines(lines, Math.max(0, facts.length - 8), "facts");
  const relationships = asArray(value.relationships);
  section(lines, "RELATIONSHIPS", relationships.length);
  for (const relationship of relationships.slice(0, 8)) {
    const kind = str(relationship.relationship) || "related";
    lines.push(L(t("  "), badge(kind.toUpperCase(), KIND_TONE[kind] ?? "text"), t(` ${clip(relationship.from, 36)} → ${clip(relationship.to, 36)}`), relationship.explanation ? dim(`  · ${clip(relationship.explanation)}`) : dim("")));
  }
  moreLines(lines, Math.max(0, relationships.length - 8), "relationships");
  const earlier = asStrings(value.earlierChoices);
  if (earlier.length) lines.push(L(t("CHOSEN SO FAR ", "muted"), t(earlier.map((choice) => clip(choice, 60)).join("  ⇒  "), "success")));
  const considered = asArray(value.alternativesAlreadyConsidered);
  section(lines, "CONSIDERED", considered.length);
  for (const alternative of considered.slice(0, 6)) {
    const style = STATUS_STYLE[str(alternative.status)] ?? STATUS_STYLE["still possible"];
    lines.push(L(t(`  ${style.glyph} `, style.tone), t(clip(alternative.approach))));
    const reasons = asStrings(alternative.reasonsRejected);
    if (reasons.length) lines.push(L(dim(`      rejected: ${clip(reasons.join("; "))}`)));
  }
  moreLines(lines, Math.max(0, considered.length - 6), "alternatives");
  const outputs = asArray(value.outputs);
  section(lines, "OUTPUTS", outputs.length);
  for (const output of outputs.slice(0, 8)) lines.push(L(t(`  ${output.passed === false ? "✗" : "✓"} ${clip(output.kind, 10)}`, output.passed === false ? "error" : "success"), t(` ${clip(output.path ?? output.summary)}`)));
  const decideOrSplit = asObject(value.decideOrSplit);
  if (decideOrSplit) {
    section(lines, "DECIDE OR SPLIT");
    if (typeof decideOrSplit.carryOutNow === "string") lines.push(L(t("  CARRY OUT NOW ", "muted"), t(clip(decideOrSplit.carryOutNow))));
    if (typeof decideOrSplit.settleFirst === "string") lines.push(L(t("  SETTLE FIRST ", "muted"), t(clip(decideOrSplit.settleFirst))));
  }
  const positions = asArray(value.successCriteriaPositions);
  if (positions.length) lines.push(L(t("POSITIONS ", "muted"), t(positions.map((position) => `#${String(position.position)} ${clip(position.criterion, 30)}`).join(" · "), "text")));
  const blocked = asObject(value.ifBlocked);
  if (blocked) {
    const guidance = [str(blocked.missingFact) && `missing fact → ${blocked.missingFact}`, str(blocked.wrongChoice) && `wrong choice → ${blocked.wrongChoice}`].filter(Boolean).join("; ");
    if (guidance) lines.push(L(t("IF BLOCKED ", "muted"), dim(clip(guidance))));
  } else if (typeof value.ifFactIsMissing === "string") {
    lines.push(L(t("IF FACT MISSING ", "muted"), dim(clip(value.ifFactIsMissing))));
  }
  return lines.slice(0, MAX_LINES);
}

export function flattenSchemaLines(lines: SchemaLine[]): string {
  return lines.map((line) => line.spans.filter(Boolean).map((span) => span.text).join("")).join("\n").trimEnd();
}

/** Render an activation output from its raw text: direct JSON, fenced JSON, or nothing. */
export function renderSchemaText(text: string | undefined): SchemaLine[] | undefined {
  if (!text) return undefined;
  const candidates = [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ""];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const lines = renderSchemaOutput(JSON.parse(candidate));
      if (lines) return lines;
    } catch { /* try next candidate */ }
  }
  return undefined;
}
