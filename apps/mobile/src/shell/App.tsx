import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { FieldProvider, useField } from "../state/FieldProvider";
import { SignInScreen } from "../screens/SignInScreen";
import { DayScreen } from "../screens/DayScreen";
import { VisitScreen } from "../screens/VisitScreen";
import { SignatureScreen } from "../screens/SignatureScreen";
import { OutboxScreen } from "../screens/OutboxScreen";
import { color } from "../components/theme";

/**
 * Five screens and a stack, held in state rather than in a navigation
 * library. The app is a list, a detail, a signature pad and a list of
 * problems; a router would be the largest dependency in it and do nothing
 * the back button below does not.
 */
export type Route =
  | { name: "day" }
  | { name: "visit"; visitId: string }
  | { name: "signature"; visitId: string }
  | { name: "outbox" }
  | { name: "sign-in-again" };

export interface Navigate {
  push(route: Route): void;
  back(): void;
}

function Screens() {
  const field = useField();
  const [stack, setStack] = useState<Route[]>([{ name: "day" }]);
  const route = stack[stack.length - 1]!;

  const nav: Navigate = {
    push: (next) => setStack((s) => [...s, next]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
  };

  const onBack = useCallback(() => {
    if (stack.length <= 1) return false;
    setStack((s) => s.slice(0, -1));
    return true;
  }, [stack.length]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [onBack]);

  // A fresh sign in starts from the day.
  useEffect(() => {
    if (field.status !== "ready") setStack([{ name: "day" }]);
  }, [field.status]);

  if (field.status === "loading") {
    return <View style={styles.center}><ActivityIndicator size="large" color={color.ink} /></View>;
  }
  if (field.status === "signed-out") return <SignInScreen />;

  switch (route.name) {
    case "visit": return <VisitScreen visitId={route.visitId} nav={nav} />;
    case "signature": return <SignatureScreen visitId={route.visitId} nav={nav} />;
    case "outbox": return <OutboxScreen nav={nav} />;
    case "sign-in-again": return <SignInScreen again onDone={nav.back} />;
    default: return <DayScreen nav={nav} />;
  }
}

export function App() {
  return (
    <SafeAreaProvider>
      <FieldProvider>
        <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
          <StatusBar style="dark" />
          <Screens />
        </SafeAreaView>
      </FieldProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
