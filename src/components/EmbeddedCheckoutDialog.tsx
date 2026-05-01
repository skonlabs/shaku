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

        {/* Trust-forward header — leads with Stripe logo + security */}
        <div className="border-b border-border/50 bg-gradient-to-b from-muted/40 to-background px-6 pt-6 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-foreground">
                <span className="text-xs font-medium text-muted-foreground">Secure checkout by</span>
                <StripeWordmark className="h-5 w-auto text-foreground" />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Payments are processed by Stripe, a PCI-DSS Level 1 certified
                provider. Your card details are encrypted end-to-end — we never
                see or store them.
              </p>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <Lock className="h-3 w-3 text-primary" />
              Encrypted
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
      </DialogContent>
    </Dialog>
  );
}
