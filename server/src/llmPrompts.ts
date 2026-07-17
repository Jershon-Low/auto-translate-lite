export const TRANSLATION_FIXED_RULES =
  "Preserve polarity and negation exactly. Never invert a positive statement into a negative one, or vice versa. Don't add, remove, or reinterpret theological meaning — when unsure, translate literally rather than paraphrasing. Take care with how God, Jesus, the Holy Spirit, and Scripture are referred to and what is said about them.";

export const TRANSLATION_DEFAULT_NOTES =
  'This is an Australian church, so expect Australian slang, idioms, jokes, and dry understatement (e.g. "heaps," "no worries," "keen," "arvo," "she\'ll be right," "having a go"). Translate for the speaker\'s intended meaning and tone, not word-for-word — don\'t flatten idiomatic phrasing into something overly formal, and don\'t translate slang literally into an unrelated meaning.';

export const TRANSCRIPTION_VERIFIER_FIXED_RULES_INTRO =
  'You are a transcription accuracy checker for live captions at an Australian church sermon. This line was auto-transcribed live from spoken audio by speech-to-text, which occasionally mishears a word — dropping or inserting a "not", mishearing a name, or similar. Decide whether this line, taken at face value, confidently states something false about God, Jesus, the Holy Spirit, or core Christian belief.\n\nDo NOT flag a line just because it is idiomatic, informal, or grammatically rough — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she\'ll be right"), and normal spoken imperfection is expected and not a sign of an error.';

export const TRANSCRIPTION_VERIFIER_FIXED_RULES_OUTRO =
  'Only mark it unsafe if the line, as transcribed, clearly and confidently misrepresents who God, Jesus, or the Holy Spirit is or does — the kind of thing a dropped or inserted "not" would cause. If safe is true, set reason to an empty string; only write a reason when safe is false.';

export const TRANSCRIPTION_VERIFIER_DEFAULT_NOTES =
  'Language Specific Notes:\nBAHASE INDONESIA: Do NOT flag a line just because it uses the word "Allah" — this is the correct word for God in Indonesian, and is not a misrepresentation of Christian belief.  \n\nNaming Notes:\nCIEL is a cafe in Melbourne, do not remove\nPlanetshakers is the church in Melbourne, do not remove';

export const TRANSLATION_VERIFIER_FIXED_RULES_INTRO =
  "You are a safety checker for live captions at an Australian church sermon. For each numbered pair below, decide whether the translation is safe to show: it must preserve the original's meaning and polarity, and must not misrepresent who God, Jesus, or the Holy Spirit is or does.";

export const TRANSLATION_VERIFIER_FIXED_RULES_OUTRO =
  "Only mark a translation unsafe if it inverts a positive statement into a negative one (or vice versa), negates or contradicts the original, reverses who is doing or receiving an action, or misrepresents God/Jesus/the Holy Spirit. If safe is true, set reason to an empty string; only write a reason when safe is false.";

export const TRANSLATION_VERIFIER_DEFAULT_NOTES =
  'Do NOT flag a translation just because it is idiomatic or non-literal — this sermon includes Australian slang, jokes, and dry humor (e.g. "no worries," "arvo," "having a go," "she\'ll be right"), and a natural, non-literal rendering of those is expected and correct.';

function buildTranslateContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (do not translate these — they're for reference only, e.g. to resolve pronouns or match terminology):
${numbered}

`;
}

export function buildTranslateTaskText(
  languageCodes: string[],
  englishText: string,
  precedingContext: string[],
  instructionBlock = ''
): string {
  return `Translate the following sentence, spoken during a live Australian church sermon, into each of these language codes: ${languageCodes.join(', ')}. Keep the tone natural and spoken, not overly formal.

${instructionBlock}${buildTranslateContextBlock(precedingContext)}Sentence: "${englishText}"`;
}

export function buildTranslateBacklogTaskText(englishLines: string[], languageCode: string, instructionBlock = ''): string {
  return `Translate each of these sentences, spoken during a live Australian church sermon, into language code "${languageCode}". Return the translations in the exact same order as the input.

${instructionBlock}Sentences: ${JSON.stringify(englishLines)}`;
}

function buildVerifierContextBlock(precedingContext: string[]): string {
  if (precedingContext.length === 0) return '';
  const numbered = precedingContext.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  return `For context, here are the immediately preceding sentences from the same sermon (not to be evaluated themselves — only for resolving pronouns or continuing a thought):\n${numbered}\n\n`;
}

export function buildTranscriptionVerifierTaskText(english: string, precedingContext: string[]): string {
  return `${buildVerifierContextBlock(precedingContext)}Line: "${english}"

Return whether it is safe and a short reason.`;
}

export function buildTranslationVerifierTaskText(items: { id: string; english: string; translated: string }[]): string {
  const pairs = items
    .map((item, index) => `${index + 1}. [id: "${item.id}"] English: "${item.english}" | Translation: "${item.translated}"`)
    .join('\n');
  return `Pairs:
${pairs}

Return, for each id, whether it is safe and a short reason.`;
}
