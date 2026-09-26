import { defaultKeymap } from "@codemirror/commands";

const disabledBindings = new Set(["Alt-ArrowUp", "Alt-ArrowDown"]);

export const editorDefaultKeymap = defaultKeymap.filter(binding => !binding.key || !disabledBindings.has(binding.key));
