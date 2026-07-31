QUÉ ENTREGÁS: una APP MÓVIL MULTIPLATAFORMA de verdad, en React Native (Expo),
que corre en el emulador de Android y en el simulador de iPhone.
NO una web, NO una maqueta HTML.

ESTRUCTURA OBLIGATORIA (rutas exactas, el motor instala y corre con ellas):
  package.json          (expo, react, react-native, expo-router si hace falta)
  app.json              (name, slug, orientation, icon, splash)
  App.jsx               (punto de entrada)
  src/screens/*.jsx     (una pantalla por archivo)
  src/components/*.jsx  (lo reutilizable)
  src/theme.js          (colores, tipografía y espaciado: fuente única)

REGLAS (si las rompés, no arranca):
- Componentes de react-native: View, Text, Pressable, FlatList, ScrollView.
  NUNCA div, span ni etiquetas HTML: esto no es una web.
- Estilos con StyleSheet.create y valores de src/theme.js. Nada de CSS.
- Listas largas con FlatList (virtualizada), nunca .map() dentro de un ScrollView.
- Navegación por pila para flujos, pestañas abajo para secciones paralelas.
- Solo dependencias del núcleo de Expo. Nada exótico.

DISEÑO (además del piso de calidad de abajo, que ya vale acá):
- Respetá las zonas seguras (SafeAreaView). El texto escala con el sistema: nada de alturas fijas.
- Animaciones con la API Animated y AccessibilityInfo.isReduceMotionEnabled().
