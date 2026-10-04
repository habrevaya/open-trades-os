import { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { buildInspection, checkReading, type CheckpointEntry } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { SIGNATURE_PAD_HTML } from "../lib/signature-pad";
import { Button, Card, Field, Notice, Section } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * RUNNING AN INSPECTION
 *
 * The programme's checkpoints, one card each: Pass and Fail for a check, a
 * box for a reading with its range beside it and a warning the moment the
 * number is outside it, not applicable behind a reason, a photo and a note.
 * Then the inspector's name and licence and a signature, and one button.
 *
 * The phone sends what was seen, never a verdict. The server draws pass,
 * fail or not finished from the programme, so a checkpoint left blank makes
 * the inspection not finished rather than passed, and the phone says so
 * before filing rather than after. Everything goes into the queue first,
 * like every other tap, so a plant room with no signal loses nothing.
 */
export function InspectionScreen({ visitId, programId, nav }: { visitId: string; programId: string; nav: Navigate }) {
  const field = useField();
  const program = field.view?.inspectionPrograms.find((p) => p.id === programId);
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const pad = useRef<WebView>(null);
  const [entries, setEntries] = useState<Record<string, CheckpointEntry>>({});
  const [inspector, setInspector] = useState(field.session?.name ?? "");
  const [license, setLicense] = useState("");
  const [signedBy, setSignedBy] = useState(field.session?.name ?? "");
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signature = useRef<string | null>(null);
  /** What to do once the pad has handed over its picture, which it does only when asked. */
  const awaiting = useRef<(() => void) | null>(null);

  if (!program || !visit) {
    return (
      <View style={styles.root}>
        <Header title="Inspection" onBack={nav.back} />
        <View style={styles.content}><Notice tone="amber">This programme is no longer on your phone. Sync and try again.</Notice></View>
      </View>
    );
  }

  const set = (key: string, change: Partial<CheckpointEntry>) =>
    setEntries((all) => ({ ...all, [key]: { ...all[key], ...change } }));

  const send = async () => {
    const built = buildInspection({ program, entries, by: inspector.trim() || signedBy.trim(), at: new Date() });
    setSaving(true);
    const failed = await field.fileInspection(visitId, {
      program, built, inspectorName: inspector, inspectorLicense: license, signedByName: signedBy,
      signature: signature.current,
    });
    setSaving(false);
    if (failed) setProblem(failed);
    else nav.back();
  };

  const file = () => {
    const built = buildInspection({ program, entries, by: inspector.trim() || signedBy.trim(), at: new Date() });
    if (built.answers.length === 0) { setProblem("Nothing has been answered yet."); return; }
    if (!signedBy.trim()) { setProblem("Type your name to sign the inspection off."); return; }
    const go = () => {
      /**
       * The pad hands over its picture only when asked, so a finished
       * signature is fetched now, at the moment of filing, rather than after
       * its first stroke.
       */
      if (drawn) {
        awaiting.current = () => void send();
        pad.current?.injectJavaScript("window.signatureSave(); true;");
      } else {
        void send();
      }
    };
    if (built.unanswered.length > 0) {
      Alert.alert(
        "File it as not finished?",
        `Not answered: ${built.unanswered.join(", ")}. It will be filed as not finished, which is not a pass.`,
        [{ text: "Keep going", style: "cancel" }, { text: "File it", onPress: go }],
      );
      return;
    }
    go();
  };

  const onPad = (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === "drawn") { setDrawn(true); return; }
    signature.current = data === "empty" ? null : data;
    if (data === "empty") setDrawn(false);
    const next = awaiting.current;
    awaiting.current = null;
    next?.();
  };

  return (
    <View style={styles.root}>
      <Header title={program.name} onBack={nav.back} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.soft}>{visit.customer.name}, {visit.property.addressLine1}</Text>
        {program.standard ? <Text style={type.soft}>Performed under {program.standard}</Text> : null}

        {program.checkpoints.map((checkpoint, index) => {
          const entry = entries[checkpoint.key] ?? {};
          const na = entry.notApplicable !== undefined;
          const reading = checkpoint.requiresReading ? checkReading(checkpoint, entry.reading ?? "") : null;
          const range = checkpoint.min !== null && checkpoint.max !== null ? `${checkpoint.min} to ${checkpoint.max}`
            : checkpoint.min !== null ? `at least ${checkpoint.min}` : checkpoint.max !== null ? `at most ${checkpoint.max}` : "";
          return (
            <Card key={checkpoint.key}>
              <Text style={type.heading}>{index + 1}. {checkpoint.label}</Text>
              {checkpoint.requiresReading ? (
                <View style={styles.readingRow}>
                  <TextInput
                    value={entry.reading ?? ""}
                    onChangeText={(text) => set(checkpoint.key, { reading: text })}
                    editable={!na}
                    keyboardType="decimal-pad"
                    accessibilityLabel={`${checkpoint.label} reading`}
                    style={styles.reading}
                  />
                  <Text style={type.body}>{checkpoint.unit ?? ""}</Text>
                  <Text style={type.soft}>{range}</Text>
                </View>
              ) : (
                <View style={styles.choices}>
                  {([true, false] as const).map((passed) => {
                    const on = entry.passed === passed;
                    return (
                      <Pressable
                        key={String(passed)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on, disabled: na }}
                        accessibilityLabel={`${checkpoint.label}: ${passed ? "pass" : "fail"}`}
                        disabled={na}
                        onPress={() => set(checkpoint.key, { passed })}
                        style={[styles.choice, on && (passed ? styles.pass : styles.fail)]}
                      >
                        <Text style={[type.body, on && { color: passed ? color.green : color.red, fontWeight: "600" }]}>
                          {passed ? "Pass" : "Fail"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {reading && (reading.state === "out_of_range" || reading.state === "not_a_number")
                ? <Notice tone="red">{reading.message}</Notice> : null}

              <View style={styles.tools}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: na }}
                  accessibilityLabel={`${checkpoint.label} does not apply`}
                  onPress={() => set(checkpoint.key, { notApplicable: na ? undefined : "" })}
                  style={styles.tool}
                >
                  <Text style={type.soft}>{na ? "✓ Not applicable" : "Not applicable"}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Photo for ${checkpoint.label}`}
                  onPress={async () => {
                    const kept = await field.checkpointPhoto(visitId);
                    if (!kept) return;
                    if ("problem" in kept) { setProblem(kept.problem); return; }
                    set(checkpoint.key, { photoIds: [...(entry.photoIds ?? []), kept.uploadId] });
                  }}
                  style={styles.tool}
                >
                  <Text style={type.soft}>Photo{entry.photoIds?.length ? ` (${entry.photoIds.length})` : ""}</Text>
                </Pressable>
              </View>
              {na ? (
                <Field label="Why it does not apply" value={entry.notApplicable ?? ""}
                       onChangeText={(text) => set(checkpoint.key, { notApplicable: text })} />
              ) : null}
              <Field label="What you saw (optional)" value={entry.note ?? ""}
                     onChangeText={(text) => set(checkpoint.key, { note: text })} />
            </Card>
          );
        })}

        <Section title="Sign it off">
          <Field label="Inspector" value={inspector} onChangeText={setInspector} autoCapitalize="words" />
          <Field label="Licence number" value={license} onChangeText={setLicense} autoCapitalize="characters" />
          <Field label="Your name, as you sign" value={signedBy} onChangeText={setSignedBy} autoCapitalize="words" />
          <View style={styles.pad}>
            <WebView
              ref={pad}
              source={{ html: SIGNATURE_PAD_HTML }}
              onMessage={onPad}
              scrollEnabled={false}
              originWhitelist={["about:blank"]}
              javaScriptEnabled
              style={{ backgroundColor: "#fff" }}
            />
          </View>
          <Button label="Clear signature" kind="secondary"
                  onPress={() => { signature.current = null; setDrawn(false); pad.current?.injectJavaScript("window.signatureClear(); true;"); }} />
          <Text style={[type.soft, { marginTop: space.sm }]}>
            {drawn ? "Signed." : "Sign in the box, or file it with your typed name only."}
          </Text>
        </Section>

        {problem ? <Notice tone="red">{problem}</Notice> : null}
        <View style={{ marginTop: space.md }}>
          <Button label="File inspection" busy={saving} onPress={file} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  readingRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm },
  reading: {
    width: 120, minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 6,
    paddingHorizontal: space.md, fontSize: 18, color: color.ink, backgroundColor: color.canvas,
  },
  choices: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  choice: {
    flex: 1, minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 6,
    alignItems: "center", justifyContent: "center", backgroundColor: color.canvas,
  },
  pass: { borderColor: color.green, backgroundColor: color.greenTint },
  fail: { borderColor: color.red, backgroundColor: color.redTint },
  tools: { flexDirection: "row", gap: space.lg, marginTop: space.sm },
  tool: { minHeight: 44, justifyContent: "center" },
  pad: {
    height: 200, borderWidth: 1, borderColor: color.line, borderRadius: 8, overflow: "hidden",
    marginVertical: space.md, backgroundColor: "#fff",
  },
});
