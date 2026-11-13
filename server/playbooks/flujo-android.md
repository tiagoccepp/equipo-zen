FLOW (this order, do not skip):
1. First the Gradle files: settings.gradle.kts, build.gradle.kts, gradle.properties and
   app/build.gradle.kts. Without them nothing you write after will compile.
2. AndroidManifest.xml: namespace must match the code package.
3. ui/Theme.kt: Material 3 color roles, light and dark.
4. The @Composable screens in ui/; finally MainActivity.kt with the first one.
5. BEFORE finish: run `gradle assembleDebug`. Read the compiler error and
   fix it in THIS run: warm builds take seconds.
6. finish with the summary and files.

COMMON MISTAKES:
- Applying org.jetbrains.kotlin.android: AGP 9 already includes Kotlin and breaks the build.
- Missing Compose imports (Modifier, dp, the @Composable functions you use).
- Namespace and package different: Activity not found.

DO NOT ITERATE: if assembleDebug passes and the screen handles its three states, it's ready.
