import { useEffect, useRef } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe() {
  if (!stripePromise) {
    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
    if (!pk) {
      console.error("VITE_STRIPE_PUBLISHABLE_KEY is not set");
      return Promise.resolve(null);
    }
    stripePromise = loadStripe(pk);
  }
  return stripePromise;
}

export function EmbeddedCheckoutDialog({
  open,
  onOpenChange,
  clientSecret,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientSecret: string | null;
}) {
  const keyRef = useRef(clientSecret);
  // Force remount when clientSecret changes (Stripe requires it)
  if (clientSecret && clientSecret !== keyRef.current) {
    keyRef.current = clientSecret;
  }

  useEffect(() => {
    if (open && !clientSecret) onOpenChange(false);
  }, [open, clientSecret, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Upgrade to Basic</DialogTitle>
        </DialogHeader>
        <div className="px-2 pb-2">
          {clientSecret && (
            <EmbeddedCheckoutProvider
              key={clientSecret}
              stripe={getStripe()}
              options={{ clientSecret }}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
