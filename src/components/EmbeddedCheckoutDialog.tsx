import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { ShieldCheck, Lock, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

function StripeWordmark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 60 25"
      fill="currentColor"
      aria-label="Stripe"
      role="img"
    >
      <path d="M59.64 14.28h-8.06c.19 1.93 1.6 2.55 3.2 2.55 1.64 0 2.96-.37 4.05-.95v3.32a8.33 8.33 0 0 1-4.56 1.1c-4.01 0-6.83-2.5-6.83-7.48 0-4.19 2.39-7.52 6.3-7.52 3.92 0 5.96 3.28 5.96 7.5 0 .4-.04 1.26-.06 1.48zm-5.92-5.62c-1.03 0-2.17.73-2.17 2.58h4.25c0-1.85-1.07-2.58-2.08-2.58zM40.95 20.3c-1.44 0-2.32-.6-2.9-1.04l-.02 4.63-4.12.87V5.57h3.62l.21 1.02a4.7 4.7 0 0 1 3.23-1.29c2.9 0 5.62 2.6 5.62 7.4 0 5.23-2.7 7.6-5.64 7.6zM40 9.05c-.95 0-1.54.34-1.97.81l.02 6.12c.4.44.98.78 1.95.78 1.52 0 2.54-1.65 2.54-3.87 0-2.15-1.04-3.84-2.54-3.84zM28.24 5.57h4.13v14.44h-4.13V5.57zm0-4.7L32.37 0v3.36l-4.13.88V.88zm-4.32 9.35v9.79H19.8V5.57h3.7l.27 1.22c1-1.77 3.07-1.41 3.62-1.22v3.79c-.52-.17-2.29-.43-3.47 1.06zm-8.91 4.55c0 2.43 2.6 1.68 3.12 1.46v3.36c-.55.3-1.54.54-2.89.54a4.15 4.15 0 0 1-4.27-4.24l.01-13.17 4.02-.86v3.54h3.14V9.1h-3.13v5.67zm-4.91.7c0 2.72-2.16 4.26-5.31 4.26a10.7 10.7 0 0 1-4.12-.86v-3.93c1.26.69 2.86 1.2 4.13 1.2.85 0 1.47-.23 1.47-.93 0-1.81-5.97-1.13-5.97-5.49 0-2.68 2.05-4.28 5.12-4.28 1.27 0 2.54.2 3.81.7v3.88a8.84 8.84 0 0 0-3.81-.99c-.8 0-1.3.23-1.3.81 0 1.71 6 .9 6 5.43z" />
    </svg>
  );
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0 gap-0">
        {/* Trust header */}
        <DialogHeader className="space-y-3 border-b border-border/60 bg-gradient-to-br from-primary/5 to-transparent px-6 pt-6 pb-5">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-card/80 px-2.5 py-1 text-xs font-medium text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Upgrade
            </div>
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              <span>Powered by</span>
              <StripeWordmark className="h-3.5 w-auto text-foreground/80" />
            </div>
          </div>

          <div className="space-y-1 text-left">
            <DialogTitle className="font-display text-2xl font-semibold tracking-tight">
              Upgrade to Basic
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Your payment is securely processed by Stripe — a PCI-DSS Level 1
              certified provider trusted by millions of businesses worldwide.
              We never see or store your card details.
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Stripe checkout form */}
        <div className="px-2 pt-2 pb-1 bg-background">
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

        {/* Trust footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span>256-bit TLS encryption</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-primary" />
            <span>PCI-DSS compliant</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span>Cancel anytime</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
