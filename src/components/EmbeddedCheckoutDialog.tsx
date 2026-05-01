import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { Lock } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import * as VisuallyHiddenPrimitive from "@radix-ui/react-visually-hidden";
import { getStripePublishableKey } from "@/lib/credits/billing.functions";

let stripePromise: Promise<Stripe | null> | null = null;
async function getStripeClient() {
  if (!stripePromise) {
    const { publishableKey } = await getStripePublishableKey();
    if (!publishableKey) {
      console.error("Stripe publishable key not configured");
      return null;
    }
    stripePromise = loadStripe(publishableKey);
  }
  return stripePromise;
}

export function EmbeddedCheckoutDialog({
  open,
  onOpenChange,
  clientSecret,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientSecret: string | null;
  onComplete: () => void;
}) {
  const [stripe, setStripe] = useState<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    if (open && !stripe) {
      void getStripeClient().then((s) => setStripe(Promise.resolve(s)));
    }
  }, [open, stripe]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden rounded-2xl border-border/60 bg-background shadow-2xl"
      >
        <VisuallyHiddenPrimitive.Root>
          <DialogTitle>Complete your upgrade</DialogTitle>
          <DialogDescription>
            Secure checkout powered by Stripe. Your card details are never seen or stored by us.
          </DialogDescription>
        </VisuallyHiddenPrimitive.Root>

        {/* Minimal header — just enough context, lets Stripe's polished UI breathe */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="space-y-0.5">
            <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
              Complete your upgrade
            </h2>
            <p className="text-xs text-muted-foreground">
              You can cancel anytime from your billing page.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <Lock className="h-3 w-3" />
            Secure
          </div>
        </div>

        {/* Stripe checkout — full bleed, scrollable on small screens */}
        <div className="max-h-[75vh] overflow-y-auto bg-background pb-2">
          {clientSecret && stripe && (
            <EmbeddedCheckoutProvider
              key={clientSecret}
              stripe={stripe}
              options={{ clientSecret, onComplete }}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
