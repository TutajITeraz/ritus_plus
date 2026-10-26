import { useEffect, useMemo, useState } from "react";
import { createListCollection } from "@chakra-ui/react";
import { getClaudeSettings } from "../apiUtils";
import { isClaudeModel } from "./modelLabels";

// Whether the current user can call Claude (own key or one shared with them).
// null = not known yet. Shared across components so the many model dropdowns
// mounted at once trigger one request; ClaudeSettings pushes updates here.
let available = null;
let pending = null;
const listeners = new Set();

export const setClaudeAvailable = (value) => {
  available = value;
  listeners.forEach((listener) => listener(value));
};

const refresh = () => {
  if (!pending) {
    pending = getClaudeSettings()
      .then((settings) => setClaudeAvailable(!!settings.active))
      .catch(() => {})
      .finally(() => { pending = null; });
  }
};

export const useClaudeAvailable = () => {
  const [value, setValue] = useState(available);
  useEffect(() => {
    listeners.add(setValue);
    refresh();
    return () => listeners.delete(setValue);
  }, []);
  return value;
};

// Model dropdown collection with Claude entries disabled while no key is
// usable. Unknown (still loading) counts as available to avoid a grey flash.
export const useModelCollection = (items) => {
  const claudeAvailable = useClaudeAvailable();
  return useMemo(
    () =>
      createListCollection({
        items:
          claudeAvailable === false
            ? items.map((item) =>
                isClaudeModel(item.value)
                  ? { ...item, label: `${item.label} (set API key in Settings to use)`, disabled: true }
                  : item
              )
            : items,
      }),
    [items, claudeAvailable]
  );
};
