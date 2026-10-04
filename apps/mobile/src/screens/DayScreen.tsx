import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  arrivalWindow, dateOf, statusLabel, todayIn, addressOf, type DayVisit,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { syncLine } from "../lib/status";
import { pushLine } from "../lib/push";
import { dayHeading } from "../lib/format";
import { Button, Card, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import type { Navigate } from "../shell/App";

/**
 * THE DAY
 *
 * The visits in route order, today and then tomorrow, each with who, what,
 * where and when on the card itself, because those are the questions asked
 * of this list from the driver's seat. Drawn entirely from what is on the
 * phone, so it opens in a basement.
 */
export function DayScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const view = field.view;
  const zone = field.session?.timezone ?? "UTC";
  const today = todayIn(zone);
  const visits = view?.day.visits ?? [];
  const todays = visits.filter((v) => (dateOf(v.windowStart, zone) ?? today) <= today);
  const later = visits.filter((v) => (dateOf(v.windowStart, zone) ?? today) > today);
  const done = todays.filter((v) => v.stage === "completed").length;

  const line = syncLine({
    waiting: view?.waiting ?? 0,
    uploadsWaiting: view?.uploadsWaiting ?? 0,
    problems: view?.problems.length ?? 0,
    syncing: field.syncing,
    offline: field.report?.offline ?? false,
    signedOut: field.signInEnded,
    backoffUntil: view?.backoffUntil ?? null,
    lastSyncedAt: view?.lastSyncedAt ?? null,
  }, zone);

  const signOut = () => {
    const waiting = (view?.waiting ?? 0) + (view?.uploadsWaiting ?? 0);
    Alert.alert(
      "Sign out?",
      waiting > 0
        ? `${waiting} ${waiting === 1 ? "thing has" : "things have"} not reached the office yet. They stay on this phone and are sent when you sign in again.`
        : "You will need your email and password to sign back in.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void field.signOut() },
      ],
    );
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={field.syncing} onRefresh={() => void field.sync()} />}
    >
      <View style={styles.header}>
        <Text style={type.title}>{dayHeading(today)}</Text>
        <Text style={type.soft}>{done} of {todays.length} done</Text>
      </View>
      <Text style={type.soft}>{field.session?.name ?? field.session?.email} at {field.session?.organizationName}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.text}. Open what is waiting to send.`}
        onPress={() => nav.push({ name: "outbox" })}
        style={[styles.pill, line.tone === "ok" ? styles.pillOk : line.tone === "waiting" ? styles.pillWaiting : styles.pillProblem]}
      >
        <Text style={[styles.pillText, { color: line.tone === "ok" ? color.green : line.tone === "waiting" ? color.amber : color.red }]}>
          {line.text}
        </Text>
      </Pressable>

      {field.signInEnded ? (
        <Notice tone="red">
          <Text style={[type.body, { color: color.red }]}>
            Your sign in has ended. Your work is safe on this phone.
          </Text>
          <View style={{ marginTop: space.sm }}>
            <Button label="Sign in again" onPress={() => nav.push({ name: "sign-in-again" })} />
          </View>
        </Notice>
      ) : null}

      {pushLine(field.push) ? <Notice tone="amber">{pushLine(field.push)!}</Notice> : null}

      {(view?.problems.length ?? 0) > 0 ? (
        <Pressable onPress={() => nav.push({ name: "outbox" })} accessibilityRole="button">
          <Notice tone="amber">{view!.problems[0]!.detail}</Notice>
        </Pressable>
      ) : null}

      <TimeClock />

      {view === null ? null : visits.length === 0 ? (
        <Text style={[type.soft, styles.empty]}>
          {view.lastSyncedAt ? "Nothing on today." : "Your day has not reached this phone yet. Pull down to try again."}
        </Text>
      ) : (
        <>
          {todays.map((v, i) => <VisitRow key={v.id} visit={v} index={i + 1} zone={zone} onOpen={() => nav.push({ name: "visit", visitId: v.id })} />)}
          {later.length > 0 ? <Text style={[type.label, styles.later]}>Tomorrow</Text> : null}
          {later.map((v, i) => <VisitRow key={v.id} visit={v} index={i + 1} zone={zone} onOpen={() => nav.push({ name: "visit", visitId: v.id })} />)}
        </>
      )}

      <View style={styles.footer}>
        <Button label="Sign out" kind="secondary" onPress={signOut} />
      </View>
    </ScrollView>
  );
}

function TimeClock() {
  const field = useField();
  const clock = field.view?.day.clock;
  const zone = field.session?.timezone ?? "UTC";
  const open = clock?.open ?? false;
  const since = clock?.since
    ? new Date(clock.since).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })
    : null;
  return (
    <Card>
      <View style={styles.clock}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading}>{open ? "On the clock" : "Not clocked in"}</Text>
          {since ? <Text style={type.soft}>Since {since}{clock?.waiting ? ", waiting to send" : ""}</Text> : null}
        </View>
        <Button
          label={open ? "Clock out" : "Clock in"}
          kind={open ? "secondary" : "primary"}
          onPress={() => void field.record(open ? "timeclock.punch_out" : "timeclock.punch_in")}
        />
      </View>
    </Card>
  );
}

function VisitRow({ visit, index, zone, onOpen }: { visit: DayVisit; index: number; zone: string; onOpen: () => void }) {
  const window = arrivalWindow(visit.windowStart, visit.windowEnd, zone);
  const finished = visit.stage === "completed" || visit.stage === "closed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Stop ${index}, ${visit.customer.name}, ${visit.summary}, ${statusLabel(visit.status, visit.stage)}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, finished && styles.rowDone, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.badge}><Text style={styles.badgeText}>{index}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={type.heading}>{visit.customer.name}</Text>
        <Text style={type.body}>{visit.summary}</Text>
        <Text style={type.soft}>{addressOf(visit)}</Text>
        {window ? <Text style={[type.body, styles.window]}>{window}</Text> : null}
      </View>
      <View style={styles.rowStatus}>
        <Text style={type.soft}>{statusLabel(visit.status, visit.stage)}</Text>
        {visit.waiting > 0 ? <Text style={styles.waiting}>Waiting to send</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  pill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: space.md, paddingVertical: space.sm, marginVertical: space.md, minHeight: 36, justifyContent: "center" },
  pillOk: { backgroundColor: color.greenTint },
  pillWaiting: { backgroundColor: color.amberTint },
  pillProblem: { backgroundColor: color.redTint },
  pillText: { fontSize: 15, fontWeight: "600" },
  clock: { flexDirection: "row", alignItems: "center", gap: space.md },
  empty: { textAlign: "center", marginTop: space.xl * 2 },
  later: { marginTop: space.lg, marginBottom: space.sm },
  row: {
    flexDirection: "row", gap: space.md, backgroundColor: color.canvas, borderRadius: 10,
    borderWidth: 1, borderColor: color.line, padding: space.lg, marginBottom: space.md,
  },
  rowDone: { backgroundColor: "#eceef1" },
  badge: { width: 30, height: 30, borderRadius: 15, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  window: { marginTop: space.xs, fontWeight: "600" },
  rowStatus: { alignItems: "flex-end", maxWidth: 110 },
  waiting: { color: color.amber, fontSize: 13, marginTop: space.xs, textAlign: "right" },
  footer: { marginTop: space.xl },
});
