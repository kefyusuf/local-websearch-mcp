import type { SearchResultItem } from "./cache/types.js";

export function extractAnswerFromContent(question: string, combinedContent: string, sourceUrls: string[]): string {
  const lowerQuestion = question.toLowerCase();
  const questionWords = lowerQuestion.split(/\s+/);

  // Extract version numbers from content
  const versionRegex = /(\w+)\s+(\d+)\.(\d+)(?:\.(\d+))?/g;
  const versions: { name: string; major: number; minor: number; patch: number; context: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = versionRegex.exec(combinedContent)) !== null) {
    const name = match[1];
    const major = parseInt(match[2], 10);
    const minor = parseInt(match[3], 10);
    const patch = match[4] ? parseInt(match[4], 10) : 0;
    const start = Math.max(0, match.index - 60);
    const end = Math.min(combinedContent.length, match.index + match[0].length + 100);
    const context = combinedContent.slice(start, end).replace(/\n+/g, " ").trim();
    versions.push({ name, major, minor, patch, context });
  }

  // Find best answer
  let answer = "";

  // Strategy 1: Version question with labeled versions
  if (versions.length > 0) {
    // Find versions whose name appears in the question
    const relevantVersions = versions.filter((version) => {
      const nameLower = version.name.toLowerCase();
      return questionWords.some((word) => nameLower.includes(word) || word.includes(nameLower));
    });

    const candidates = relevantVersions.length > 0 ? relevantVersions : versions;

    const best = candidates.reduce((a, b) =>
      a.major !== b.major ? (a.major > b.major ? a : b) :
      a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
      a.patch > b.patch ? a : b
    );

    answer = `The latest ${best.name} version is ${best.name} ${best.major}.${best.minor}` +
      (best.patch > 0 ? `.${best.patch}` : "") + ".\n";

    // Add context from source
    const contextClean = best.context
      .replace(best.name, `**${best.name} ${best.major}.${best.minor}**`);
    answer += `\nContext: ${contextClean}\n`;
  }

  // Strategy 2: General factual answer - find sentence with most question word matches
  if (!answer) {
    const sentences = combinedContent.split(/[.!?]+\s+/);
    let bestSentence = "";
    let bestScore = 0;

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      const score = questionWords.filter((word) => lowerSentence.includes(word)).length;
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence.trim();
      }
    }

    if (bestSentence && bestScore > 0) {
      answer = `${bestSentence}.\n`;
    }
  }

  // Fallback
  if (!answer) {
    // Return first meaningful paragraph
    const paragraphs = combinedContent.split(/\n\n+/).filter((paragraph) => paragraph.trim().length > 50);
    answer = paragraphs.length > 0 ? `${paragraphs[0].trim()}\n` : "Could not extract a specific answer from the content.";
  }

  // Add sources
  const sources = sourceUrls.map((url, i) => `Source ${i + 1}: ${url}`).join("\n");
  return `Answer: ${answer}\n\n${sources}`;
}

export function formatSearchResults(query: string, results: SearchResultItem[]): string {
  void query;

  const foundVersions: { label: string; major: number; minor: number; patch: number }[] = [];

  for (const result of results) {
    const text = `${result.title} ${result.snippet}`;
    let match: RegExpExecArray | null;
    const versionPattern = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/g;
    while ((match = versionPattern.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 20), match.index);
      const labelMatch = before.match(/(\w+)\s*$/);
      const label = labelMatch ? labelMatch[1] : "";
      foundVersions.push({
        label,
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: match[3] ? parseInt(match[3], 10) : 0,
      });
    }
  }

  let summary = "";
  if (foundVersions.length > 0) {
    const best = foundVersions.reduce((a, b) =>
      a.major !== b.major ? (a.major > b.major ? a : b) :
      a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
      a.patch > b.patch ? a : b
    );
    const labelText = best.label ? `${best.label} ${best.major}.${best.minor}` : `v${best.major}.${best.minor}`;
    summary = `Version hint from search snippets: ${labelText}.\n\n`;
  }

  const formatted = results.map((result, i) => {
    const freshnessHint = formatFreshnessHint(`${result.title} ${result.snippet}`);
    return `${i + 1}. "${result.title}" - ${result.url}\n   ${result.snippet || "(no description)"}${freshnessHint ? `\n   ${freshnessHint}` : ""}`;
  }).join("\n\n");

  return summary + formatted;
}

function formatFreshnessHint(text: string): string {
  const dateHint = extractDateHint(text);
  if (!dateHint) return "";

  const parsedDate = new Date(dateHint);
  if (Number.isNaN(parsedDate.getTime())) return "";

  const ageMonths = monthDelta(parsedDate, new Date());
  if (ageMonths <= 24) return "";

  return `Freshness: possibly stale (${dateHint}).`;
}

function extractDateHint(text: string): string | null {
  const absolutePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i,
  ];

  for (const pattern of absolutePatterns) {
    const match = text.match(pattern);
    if (match) return normalizeDateHint(match[1]);
  }

  const relativeMatch = text.match(/\b(\d+)\s+(month|year)s?\s+ago\b/i);
  if (!relativeMatch) return null;

  const amount = Number(relativeMatch[1]);
  const unit = relativeMatch[2].toLowerCase();
  const date = new Date();
  if (unit.startsWith("month")) {
    date.setMonth(date.getMonth() - amount);
  } else {
    date.setFullYear(date.getFullYear() - amount);
  }

  return date.toISOString().slice(0, 10);
}

function normalizeDateHint(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

function monthDelta(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
