import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Upgrade to Basic</DialogTitle>
          <DialogDescription>
            Complete your secure payment to activate your plan.
          </DialogDescription>
        </DialogHeader>
        <div className="px-2 pb-2">
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
