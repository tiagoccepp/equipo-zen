FLOW (this order, do not skip):
1. SCAFFOLD with the official tool, never by hand:
   command `npx create-expo-app@latest . --template blank`
2. src/theme.js: colors, typography, and spacing. Single source.
3. Screens in src/screens/, reusable parts in src/components/.
4. Only then the entry point (App.js/App.jsx): delete the template content and
   mount YOUR screens.
5. BEFORE finish: run `npx tsc --noEmit`. If it fails, fix and repeat.
6. finish with the summary and files.

COMMON MISTAKES:
- Leaving App.js with the default Expo screen while the work lives in
  src/screens/: the app opens and shows the Expo banner, not the product.
- div, span, or className: this is not a web page and it won't run.
- Loose styles instead of StyleSheet.create with values from theme.js.

DO NOT ITERATE: if it compiles, navigates, and uses the theme, it's ready. No extra libraries.
