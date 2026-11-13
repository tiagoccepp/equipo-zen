WHAT YOU DELIVER: a real CROSS-PLATFORM MOBILE APP in React Native (Expo),
that runs on the Android emulator and iPhone simulator.
NOT a web page, NOT an HTML mockup.

REQUIRED STRUCTURE (exact paths, the engine installs and runs with them):
  package.json          (expo, react, react-native, expo-router if needed)
  app.json              (name, slug, orientation, icon, splash)
  App.jsx               (entry point)
  src/screens/*.jsx     (one screen per file)
  src/components/*.jsx  (reusable parts)
  src/theme.js          (colors, typography, and spacing: single source)

RULES (if you break them, it won't start):
- react-native components: View, Text, Pressable, FlatList, ScrollView.
  NEVER div, span, or HTML tags: this is not a web page.
- Styles with StyleSheet.create and values from src/theme.js. No CSS.
- Long lists with FlatList (virtualized), never .map() inside a ScrollView.
- Stack navigation for flows, bottom tabs for parallel sections.
- Only core Expo dependencies. Nothing exotic.

DESIGN (in addition to the quality floor below, which already applies here):
- Respect safe areas (SafeAreaView). Text scales with the system: no fixed heights.
- Animations with the Animated API and AccessibilityInfo.isReduceMotionEnabled().
