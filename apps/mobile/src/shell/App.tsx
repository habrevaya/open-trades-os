import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { FieldProvider, useField } from "../state/FieldProvider";
import { SignInScreen } from "../screens/SignInScreen";
import { DayScreen } from "../screens/DayScreen";
import { VisitScreen } from "../screens/VisitScreen";
import { SignatureScreen } from "../screens/SignatureScreen";
import { InspectionScreen } from "../screens/InspectionScreen";
import { OutboxScreen } from "../screens/OutboxScreen";
import { EstimateScreen } from "../screens/EstimateScreen";
import { PresentScreen } from "../screens/PresentScreen";
import { InvoiceScreen } from "../screens/InvoiceScreen";
import { TasksScreen } from "../screens/TasksScreen";
import { TalksScreen } from "../screens/TalksScreen";
import { AssistantScreen } from "../screens/AssistantScreen";
import { ExpensesScreen } from "../screens/ExpensesScreen";
import { color } from "../components/theme";
import { onNoticeTapped } from "../platform/notifications";
import { serverPage } from "../lib/push";

/**
 * Twelve screens and a stack, held in state rather than in a navigation
 * library. The app is a list, a detail, a signature pad, an inspection, a
 * list of problems, the estimate builder, the customer's screen, the
 * invoice, the office's tasks, the toolbox talks to sign, what the person paid for the
 * company and the assistant; a router would be the
 * largest dependency in it and do nothing the back button below does not.
 */
export type Route =
  | { name: "day" }
  | { name: "visit"; visitId: string }
  | { name: "signature"; visitId: string }
  | { name: "inspection"; visitId: string; programId: string }
  | { name: "outbox" }
  | { name: "sign-in-again" }
  | { name: "estimate-new"; visitId: string }
  | { name: "present"; visitId: string; estimateId: string }
  | { name: "invoice"; visitId: string }
  /** `taskId` is the one a tapped notice is about, `href` where the browser would open it. */
  | { name: "tasks"; taskId?: string; href?: string | null }
  | { name: "talks" }
  | { name: "expenses" }
  | { name: "assistant"; visitId: string | null };

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

  /**
   * A tapped notice opens what it is about: a visit or a task on the phone, the
   * talks or the expenses, and for anything else the page the bell would open,
   * in the browser. Opening it marks it read, through the queue, so it counts
   * on the bell in a browser too even when the tap was where there is no signal.
   */
  const latest = useRef(field);
  latest.current = field;
  useEffect(() => {
    if (field.status !== "ready") return;
    return onNoticeTapped((tap) => {
      const now = latest.current;
      if (tap.noticeId) void now.record("notice.read", tap.noticeId);
      const target = tap.target;
      switch (target.open) {
        case "visit": setStack([{ name: "day" }, { name: "visit", visitId: target.visitId }]); break;
        case "task": setStack([{ name: "day" }, { name: "tasks", taskId: target.taskId, href: target.href }]); break;
        case "talks": setStack([{ name: "day" }, { name: "talks" }]); break;
        case "expenses": setStack([{ name: "day" }, { name: "expenses" }]); break;
        case "browser": {
          const page = now.session ? serverPage(now.session.serverUrl, target.href) : null;
          if (page) void Linking.openURL(page).catch(() => undefined);
          break;
        }
      }
    });
  }, [field.status]);

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
    case "inspection": return <InspectionScreen visitId={route.visitId} programId={route.programId} nav={nav} />;
    case "outbox": return <OutboxScreen nav={nav} />;
    case "sign-in-again": return <SignInScreen again onDone={nav.back} />;
    case "estimate-new": return <EstimateScreen visitId={route.visitId} nav={nav} />;
    case "present": return <PresentScreen visitId={route.visitId} estimateId={route.estimateId} nav={nav} />;
    case "invoice": return <InvoiceScreen visitId={route.visitId} nav={nav} />;
    case "tasks": return <TasksScreen nav={nav} taskId={route.taskId ?? null} href={route.href ?? null} />;
    case "talks": return <TalksScreen nav={nav} />;
    case "expenses": return <ExpensesScreen nav={nav} />;
    case "assistant": return <AssistantScreen visitId={route.visitId} nav={nav} />;
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
