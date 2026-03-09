import type { components } from "../types/generated";

type Editor = components["schemas"]["Editor"];

export const EDITORS: Editor[] = [
  // VS Code & Variants
  { id: "vscode", name: "VS Code", color: "#007ACC", website: "https://code.visualstudio.com" },
  { id: "vscodium", name: "VSCodium", color: "#2F80ED", website: "https://vscodium.com" },
  { id: "cursor", name: "Cursor", color: "#000000", website: "https://cursor.com" },
  { id: "windsurf", name: "Windsurf", color: "#00D4AA", website: "https://codeium.com/windsurf" },

  // JetBrains Family
  { id: "intellij-idea", name: "IntelliJ IDEA", color: "#FE315D", website: "https://www.jetbrains.com/idea" },
  { id: "webstorm", name: "WebStorm", color: "#07C3F2", website: "https://www.jetbrains.com/webstorm" },
  { id: "pycharm", name: "PyCharm", color: "#21D789", website: "https://www.jetbrains.com/pycharm" },
  { id: "goland", name: "GoLand", color: "#087CFA", website: "https://www.jetbrains.com/go" },
  { id: "rubymine", name: "RubyMine", color: "#FE2857", website: "https://www.jetbrains.com/ruby" },
  { id: "phpstorm", name: "PhpStorm", color: "#B345F1", website: "https://www.jetbrains.com/phpstorm" },
  { id: "clion", name: "CLion", color: "#21D789", website: "https://www.jetbrains.com/clion" },
  { id: "rider", name: "Rider", color: "#DD1265", website: "https://www.jetbrains.com/rider" },
  { id: "datagrip", name: "DataGrip", color: "#22D88F", website: "https://www.jetbrains.com/datagrip" },
  { id: "fleet", name: "Fleet", color: "#7B61FF", website: "https://www.jetbrains.com/fleet" },
  { id: "rustrover", name: "RustRover", color: "#FE2857", website: "https://www.jetbrains.com/rust" },
  { id: "aqua", name: "Aqua", color: "#07C3F2", website: "https://www.jetbrains.com/aqua" },
  { id: "dataspell", name: "DataSpell", color: "#087CFA", website: "https://www.jetbrains.com/dataspell" },
  { id: "writerside", name: "Writerside", color: "#21D789", website: "https://www.jetbrains.com/writerside" },
  { id: "android-studio", name: "Android Studio", color: "#3DDC84", website: "https://developer.android.com/studio" },

  // Vim / Neovim
  { id: "vim", name: "Vim", color: "#019733", website: "https://www.vim.org" },
  { id: "neovim", name: "Neovim", color: "#57A143", website: "https://neovim.io" },
  { id: "gvim", name: "GVim", color: "#019733", website: "https://www.vim.org" },

  // Emacs
  { id: "emacs", name: "Emacs", color: "#7F5AB6", website: "https://www.gnu.org/software/emacs" },
  { id: "spacemacs", name: "Spacemacs", color: "#9266CC", website: "https://www.spacemacs.org" },
  { id: "doom-emacs", name: "Doom Emacs", color: "#7F5AB6", website: "https://github.com/doomemacs/doomemacs" },

  // Sublime / Atom
  { id: "sublime-text", name: "Sublime Text", color: "#FF9800", website: "https://www.sublimetext.com" },
  { id: "sublime-merge", name: "Sublime Merge", color: "#FF9800", website: "https://www.sublimemerge.com" },
  { id: "atom", name: "Atom", color: "#66595C", website: "https://github.com/atom/atom" },

  // Microsoft
  { id: "visual-studio", name: "Visual Studio", color: "#5C2D91", website: "https://visualstudio.microsoft.com" },
  { id: "ssms", name: "SQL Server Management Studio", color: "#CC2927", website: "https://learn.microsoft.com/en-us/sql/ssms" },
  { id: "azure-data-studio", name: "Azure Data Studio", color: "#0078D4", website: "https://learn.microsoft.com/en-us/azure-data-studio" },

  // Apple
  { id: "xcode", name: "Xcode", color: "#147EFB", website: "https://developer.apple.com/xcode" },

  // Eclipse / NetBeans
  { id: "eclipse", name: "Eclipse", color: "#2C2255", website: "https://www.eclipse.org" },
  { id: "netbeans", name: "NetBeans", color: "#1B6AC6", website: "https://netbeans.apache.org" },

  // Terminal / CLI
  { id: "terminal", name: "Terminal", color: "#4D4D4D" },
  { id: "bash", name: "Bash", color: "#4EAA25" },
  { id: "zsh", name: "Zsh", color: "#C5DB00" },
  { id: "powershell", name: "PowerShell", color: "#012456" },
  { id: "fish", name: "Fish", color: "#34AACB" },
  { id: "cmd", name: "CMD", color: "#4D4D4D" },
  { id: "nano", name: "Nano", color: "#4D4D4D" },

  // New-gen editors
  { id: "zed", name: "Zed", color: "#084CCF", website: "https://zed.dev" },
  { id: "helix", name: "Helix", color: "#281733", website: "https://helix-editor.com" },
  { id: "lapce", name: "Lapce", color: "#4E7FEE", website: "https://lapce.dev" },
  { id: "kakoune", name: "Kakoune", color: "#6699CC", website: "https://kakoune.org" },
  { id: "lite-xl", name: "Lite XL", color: "#2B91AF", website: "https://lite-xl.com" },
  { id: "micro", name: "Micro", color: "#2D2D2D", website: "https://micro-editor.github.io" },
  { id: "trae", name: "Trae", color: "#6C5CE7", website: "https://www.trae.ai" },

  // Notebooks & Data Science
  { id: "jupyter", name: "Jupyter Notebook", color: "#F37626", website: "https://jupyter.org" },
  { id: "jupyterlab", name: "JupyterLab", color: "#F37626", website: "https://jupyter.org" },
  { id: "rstudio", name: "RStudio", color: "#75AADB", website: "https://posit.co/products/open-source/rstudio" },
  { id: "positron", name: "Positron", color: "#447099", website: "https://github.com/posit-dev/positron" },
  { id: "spyder", name: "Spyder", color: "#FF0000", website: "https://www.spyder-ide.org" },
  { id: "matlab", name: "MATLAB", color: "#0076A8", website: "https://www.mathworks.com/products/matlab.html" },
  { id: "octave", name: "GNU Octave", color: "#0790C0", website: "https://octave.org" },
  { id: "mathematica", name: "Mathematica", color: "#DD1100", website: "https://www.wolfram.com/mathematica" },

  // Game Development
  { id: "unity", name: "Unity", color: "#000000", website: "https://unity.com" },
  { id: "unreal-engine", name: "Unreal Engine", color: "#0E1128", website: "https://www.unrealengine.com" },
  { id: "godot", name: "Godot", color: "#478CBF", website: "https://godotengine.org" },

  // Web / Online
  { id: "brackets", name: "Brackets", color: "#0083E8", website: "https://brackets.io" },
  { id: "coda", name: "Coda", color: "#574DBE" },
  { id: "nova", name: "Nova", color: "#6488E5", website: "https://nova.app" },
  { id: "bbedit", name: "BBEdit", color: "#000000", website: "https://www.barebones.com/products/bbedit" },
  { id: "textmate", name: "TextMate", color: "#9B2393", website: "https://macromates.com" },

  // Notepad variants
  { id: "notepad-plus-plus", name: "Notepad++", color: "#90E59A", website: "https://notepad-plus-plus.org" },
  { id: "notepad", name: "Notepad", color: "#4D4D4D" },
  { id: "wordpad", name: "WordPad", color: "#2B579A" },

  // Other IDEs
  { id: "kate", name: "Kate", color: "#1D99F3", website: "https://kate-editor.org" },
  { id: "gedit", name: "gedit", color: "#4A90D9" },
  { id: "geany", name: "Geany", color: "#347C17", website: "https://www.geany.org" },
  { id: "bluefish", name: "Bluefish", color: "#0000FF", website: "https://bluefish.openoffice.nl" },
  { id: "codeblocks", name: "Code::Blocks", color: "#000000", website: "https://www.codeblocks.org" },
  { id: "codelite", name: "CodeLite", color: "#2E8BC0", website: "https://codelite.org" },
  { id: "kdevelop", name: "KDevelop", color: "#1D99F3", website: "https://www.kdevelop.org" },
  { id: "monodevelop", name: "MonoDevelop", color: "#6C2D91", website: "https://www.monodevelop.com" },
  { id: "qt-creator", name: "Qt Creator", color: "#41CD52", website: "https://www.qt.io/product/development-tools" },
  { id: "delphi", name: "Delphi", color: "#EE1F35", website: "https://www.embarcadero.com/products/delphi" },
  { id: "lazarus", name: "Lazarus", color: "#3A6EA5", website: "https://www.lazarus-ide.org" },
];
