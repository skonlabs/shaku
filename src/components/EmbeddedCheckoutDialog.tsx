import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { Leaf, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
        <DialogTitle className="sr-only">Complete your upgrade</DialogTitle>
        <DialogDescription className="sr-only">
          Secure checkout powered by Stripe. Your card details are never seen or stored by us.
        </DialogDescription>

        {/* Brand-forward header — Cortex first, Stripe attribution in footer */}
        <div className="border-b border-border/50 bg-gradient-to-b from-muted/40 to-background px-6 pt-6 pb-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Leaf className="h-5 w-5" />
              </div>
              <div className="leading-tight">
                <div className="font-display text-base font-semibold text-foreground">Cortex</div>
                <div className="text-xs text-muted-foreground">Complete your upgrade</div>
              </div>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Secure checkout
            </div>
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

        {/* Footer — Stripe attribution, industry-standard placement */}
        <div className="border-t border-border/50 bg-muted/20 px-6 py-3">
          <p className="text-center text-[11px] text-muted-foreground">
            Payments securely processed by{" "}
            <span className="font-semibold text-foreground">Stripe</span>
            {" "}· PCI-DSS Level 1 · 256-bit encryption
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
