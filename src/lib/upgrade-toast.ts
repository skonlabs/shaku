/**
 * Shared toast for 402 / upgrade-required responses from /api/chat/stream.
 *
 * Renders a friendly message explaining what's blocked, plus a primary
 * "Upgrade" action that routes to /billing.
 */
import { toast } from "sonner";
import type { UpgradeRequiredInfo } from "./streamChat";

const FRIENDLY_TITLES: Record<NonNullable<UpgradeRequiredInfo["blocked"]>, string> = {
  credits: "You're out of credits this month",
  model: "This needs a smarter model",
  memory: "Memory is a Basic feature",
  documents: "Document Q&A is a Basic feature",
};

const FRIENDLY_BODIES: Record<NonNullable<UpgradeRequiredInfo["blocked"]>, string> = {
  credits:
    "Upgrade to Basic for 5,000 credits a month — that's enough for hundreds of long conversations.",
  model:
    "Your question is better answered by GPT-4o or Claude Sonnet, included on the Basic plan.",
  memory:
    "Let Cortex remember context across conversations. Available on Basic and above.",
  documents:
    "Chat with your uploaded files. Available on Basic and above.",
};

export function showUpgradeToast(info: UpgradeRequiredInfo): void {
  const blocked = info.blocked ?? "credits";
  const title = FRIENDLY_TITLES[blocked];
  const body = FRIENDLY_BODIES[blocked] ?? info.message;
  toast.message(title, {
    description: body,
    duration: 12_000,
    action: {
      label: "Upgrade",
      onClick: () => {
        // Use a full navigation so we don't need to plumb the router in here.
        window.location.href = info.upgradeUrl || "/billing";
      },
    },
  });
}
