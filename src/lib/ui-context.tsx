import * as React from "react";

interface KbHelpContextValue {
  open: boolean;
  setOpen: (o: boolean) => void;
}
const KbHelpContext = React.createContext<KbHelpContextValue | null>(null);

export function KbHelpProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <KbHelpContext.Provider value={{ open, setOpen }}>{children}</KbHelpContext.Provider>;
}

export function useKbHelp(): KbHelpContextValue {
  const ctx = React.useContext(KbHelpContext);
  if (!ctx) throw new Error("useKbHelp must be used within <KbHelpProvider>");
  return ctx;
}

export interface DocumentPreview {
  title: string;
  content: string;
  mime?: string;
  url?: string | null;
}

interface PanelContextValue {
  active: PanelId | null;
  setActive: (p: PanelId | null) => void;
  toggle: (p: PanelId) => void;
  document: DocumentPreview | null;
  openDocument: (doc: DocumentPreview) => void;
  closeDocument: () => void;
}
export type PanelId =
  | "chats"
  | "projects"
  | "datasources"
  | "connectors"
  | "settings"
  | "account"
  | "document";
const PanelContext = React.createContext<PanelContextValue | null>(null);

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<PanelId | null>(null);
  const [document, setDocument] = React.useState<DocumentPreview | null>(null);
  const toggle = React.useCallback((p: PanelId) => {
    setActive((cur) => (cur === p ? null : p));
  }, []);
  const openDocument = React.useCallback((doc: DocumentPreview) => {
    setDocument(doc);
    setActive("document");
  }, []);
  const closeDocument = React.useCallback(() => {
    setDocument(null);
    setActive((cur) => (cur === "document" ? null : cur));
  }, []);
  return (
    <PanelContext.Provider
      value={{ active, setActive, toggle, document, openDocument, closeDocument }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel(): PanelContextValue {
  const ctx = React.useContext(PanelContext);
  if (!ctx) throw new Error("usePanel must be used within <PanelProvider>");
  return ctx;
}
