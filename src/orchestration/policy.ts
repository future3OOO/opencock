const CONTINUATION_PATTERNS = /\b(continue|still working|what.?s happening|how.?s it going)\b/i;
const STANDALONE_CONTINUATION = /^\s*(status|progress|update)\s*\??\s*$/i;

const SIGNAL_MAP: Record<string, readonly string[]> = {
  "instagram-cycle": [
    "ig_cycle",
    "ig cycle",
    "instagram cycle",
    "engagement cycle",
    "notifications",
    "ig_check",
    "ig_post",
    "ig_engage",
    "ig_dm",
    "instagram cron",
    "full cycle",
  ],
  "self-improvement": [
    "improve yourself",
    "run self-improvement",
    "run autoresearch",
    "self-optimize",
    "improve the prompt stack",
    "instagram content quality",
    "caption optimization",
    "hashtag strategy",
    "image prompt improvement",
    "engagement pattern tuning",
    "instagram-caption-style",
    "instagram-hashtag-strategy",
    "instagram-image-prompts",
    "instagram-engagement-patterns",
  ],
  browser: [
    "browser",
    "puppeteer",
    "screenshot",
    "click",
    "navigate",
    "login",
    "signup",
    "open page",
    "web page",
    "fill form",
  ],
  "timed-work": [
    "for the next",
    "hours",
    "minutes",
    "deadline",
    "timed",
    "keep working",
    "until",
    "duration",
  ],
  "content-creation": [
    "create post",
    "generate image",
    "fal.ai",
    "caption",
    "content pipeline",
    "post image",
    "create content",
    "image generation",
  ],
  coding: [
    "write code",
    "edit code",
    "refactor",
    "implement",
    "build script",
    "fix bug",
    "coding",
    "write a script",
    "create file",
    "modify file",
    "patch",
    "rewrite",
    "update the",
    "change the",
    "rename the",
    "delete the",
    "remove the",
    "add the",
    "edit the",
    "modify the",
  ],
  "external-action": ["send email", "send dm", "api call", "post to", "publish", "email", "gmail"],
  research: [
    "research",
    "search",
    "find out",
    "competitive analysis",
    "explore",
    "investigate",
    "look up",
    "web search",
  ],
  "multi-step": [
    "then",
    "after that",
    "step 1",
    "step 2",
    "multi-step",
    "sequence",
    "pipeline",
    "chain",
  ],
};

const SIGNAL_PRIORITY = [
  "instagram-cycle",
  "self-improvement",
  "browser",
  "timed-work",
  "content-creation",
  "coding",
  "external-action",
  "research",
  "multi-step",
] as const;

function hasSignal(textLower: string, signals: readonly string[]): boolean {
  return signals.some((signal) => textLower.includes(signal));
}

function isShortReadonly(text: string): boolean {
  const stripped = text.trim();
  if (stripped.length > 300) {
    return false;
  }
  const lower = stripped.toLowerCase();
  if (["hi", "hello", "hey", "sup", "yo", "good morning", "good evening"].includes(lower)) {
    return true;
  }
  if (lower.endsWith("?") && lower.split(/\s+/).length <= 20) {
    return true;
  }
  return isContinuationLike(text);
}

export function classifyOrchestrationRequest(params: {
  text: string;
  hasBrowserNeed?: boolean;
  hasRepoMutation?: boolean;
  hasTimedCommitment?: boolean;
  toolNeeds?: string[];
}): string {
  const lower = params.text.trim().toLowerCase();
  const tools = new Set(params.toolNeeds ?? []);
  for (const routingClass of SIGNAL_PRIORITY) {
    if (hasSignal(lower, SIGNAL_MAP[routingClass])) {
      return routingClass;
    }
  }
  if (params.hasBrowserNeed || tools.has("browser")) {
    return "browser";
  }
  if (params.hasTimedCommitment) {
    return "timed-work";
  }
  if (params.hasRepoMutation) {
    return "coding";
  }
  if (
    isShortReadonly(params.text) &&
    !params.hasRepoMutation &&
    !params.hasBrowserNeed &&
    !params.hasTimedCommitment
  ) {
    return "direct-answer";
  }
  if (lower.split(/\s+/).length > 20) {
    return "research";
  }
  return "direct-answer";
}

export function shouldDelegateRoutingClass(routingClass: string): boolean {
  return routingClass !== "direct-answer";
}

export function isInlineEligible(params: {
  text: string;
  hasBrowserNeed?: boolean;
  hasRepoMutation?: boolean;
  hasTimedCommitment?: boolean;
  isMultiStep?: boolean;
}): boolean {
  if (
    params.hasBrowserNeed ||
    params.hasRepoMutation ||
    params.hasTimedCommitment ||
    params.isMultiStep
  ) {
    return false;
  }
  return isShortReadonly(params.text);
}

export function isContinuationLike(text: string): boolean {
  return CONTINUATION_PATTERNS.test(text) || STANDALONE_CONTINUATION.test(text);
}
