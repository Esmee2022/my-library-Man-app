import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    CreatoDisplay: require('../assets/fonts/CreatoDisplay-Regular.otf'),
    CreatoDisplayMedium: require('../assets/fonts/CreatoDisplay-Medium.otf'),
    CreatoDisplayBold: require('../assets/fonts/CreatoDisplay-Bold.otf'),
  });
  if (!fontsLoaded) return null;
  return <SafeAreaProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></SafeAreaProvider>;
}
