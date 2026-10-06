import { useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { addressOf, arrivalWindow, mapsUrl, nextStep, statusLabel } from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { ETA_CHOICES, photoSummary, telUrl } from "../lib/format";
import { Button, Notice, Section } from "../components/ui";
import { ChecklistSection, InspectionsSection, PartsSection, PaymentSection, ReadingsSection, UnitSection } from "./VisitWork";
import { AskSection, CashTipSection, InvoiceSection, SellSection } from "./VisitSell";
import { color, space, type } from "../components/theme";
import type { Navigate } from "../shell/App";

/**
 * ONE VISIT
 *
 * The gate code and the dog first, before anything else, because they are
 * needed before getting out of the truck. Then what the job is, the notes,
 * photos and a signature, the checklist, the readings, the parts and the
 * money (see `VisitWork`), and the one big button that moves the visit on.
 */
export function VisitScreen({ visitId, nav }: { visitId: string; nav: Navigate }) {
  const field = useField();
  const visit = field.view?.day.visits.find((v) => v.id === visitId);
  const zone = field.session?.timezone ?? "UTC";
  const [note, setNote] = useState("");
  const [eta, setEta] = useState<number>(20);
  const [etaResult, setEtaResult] = useState<string | null>(null);
  const [sendingEta, setSendingEta] = useState(false);
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);

  if (!visit) {
    return (
      <View style={styles.root}>
        <Header onBack={nav.back} title="Visit" />
        <Text style={[type.soft, { padding: space.lg }]}>This visit is no longer on your day.</Text>
      </View>
    );
  }

  const address = addressOf(visit);
  const window = arrivalWindow(visit.windowStart, visit.windowEnd, zone);
  const step = nextStep(visit.stage);
  const tel = telUrl(visit.customer.phone);
  const p = visit.property;

  const move = () => {
    if (!step) return;
    if (step.confirm) {
      Alert.alert(step.label, step.confirm, [
        { text: "Cancel", style: "cancel" },
        { text: step.label, onPress: () => void field.record(step.kind, visit.id) },
      ]);
    } else {
      void field.record(step.kind, visit.id);
    }
  };

  const openMaps = async () => {
    const native = mapsUrl(address, Platform.OS === "ios" ? "ios" : "android");
    try {
      await Linking.openURL(native);
    } catch {
      await Linking.openURL(mapsUrl(address, "web"));
    }
  };

  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title={`Job ${visit.jobNumber}`} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.title}>{visit.customer.name}</Text>
        <Text style={[type.body, { marginTop: space.xs }]}>{visit.summary}</Text>
        <Text style={[type.soft, { marginTop: space.xs }]}>
          {statusLabel(visit.status, visit.stage)}{window ? `  ·  ${window}` : ""}
          {visit.waiting > 0 ? "  ·  waiting to send" : ""}
        </Text>

        {p.hasDog || p.gateCode || p.accessNotes || p.hazardNotes ? (
          <View style={{ marginTop: space.lg }}>
            <Notice tone="amber">
              {p.hasDog ? <Text style={styles.warn}>There is a dog.</Text> : null}
              {p.gateCode ? <Text style={styles.warnText}>Gate code <Text style={styles.code}>{p.gateCode}</Text></Text> : null}
              {p.accessNotes ? <Text style={styles.warnText}>{p.accessNotes}</Text> : null}
              {p.hazardNotes ? <Text style={styles.warn}>{p.hazardNotes}</Text> : null}
            </Notice>
          </View>
        ) : null}

        <View style={styles.row}>
          {tel ? <View style={{ flex: 1 }}><Button label="Call" kind="secondary" onPress={() => void Linking.openURL(tel)} /></View> : null}
          <View style={{ flex: 1 }}><Button label="Directions" kind="secondary" onPress={() => void openMaps()} /></View>
        </View>
        <Pressable onPress={() => void openMaps()} accessibilityRole="link" accessibilityLabel={`Open ${address} in maps`}>
          <Text style={[type.body, styles.address]}>{address}</Text>
        </Pressable>

        {step ? (
          <View style={styles.step}>
            <Button label={step.label} onPress={move} />
          </View>
        ) : null}

        {visit.customerComplaint || visit.description ? (
          <Section title="The job">
            {visit.customerComplaint ? <Text style={type.body}>What they said: {visit.customerComplaint}</Text> : null}
            {visit.description ? <Text style={[type.body, { marginTop: space.xs }]}>{visit.description}</Text> : null}
          </Section>
        ) : null}

        {/*
          The company's own records on this job or a unit on this visit (the
          permit, the warranty registration), read only: changed in the
          office, on their own page.
        */}
        {(visit.records ?? []).length > 0 ? (
          <Section title="Records on this job">
            {(visit.records ?? []).map((record) => (
              <View key={record.id} style={{ marginBottom: space.sm }}>
                <Text style={[type.body, { fontWeight: "600" }]}>{record.kind}: {record.title}</Text>
                {record.fields.map((f) => (
                  <Text key={f.label} style={type.body}>{f.label}: {f.value}</Text>
                ))}
              </View>
            ))}
          </Section>
        ) : null}

        {visit.stage === "upcoming" ? (
          <Section title="Tell the customer you are coming">
            <View style={styles.etaRow}>
              {ETA_CHOICES.map((m) => (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: eta === m }}
                  accessibilityLabel={`${m} minutes`}
                  onPress={() => setEta(m)}
                  style={[styles.eta, eta === m && styles.etaOn]}
                >
                  <Text style={[styles.etaText, eta === m && { color: "#fff" }]}>{m}</Text>
                </Pressable>
              ))}
            </View>
            <Button
              label={`Text them: about ${eta} minutes`}
              kind="secondary"
              busy={sendingEta}
              onPress={async () => {
                setSendingEta(true);
                setEtaResult(await field.onMyWay(visit.id, eta));
                setSendingEta(false);
              }}
            />
            {etaResult ? <Text style={[type.soft, { marginTop: space.sm }]} accessibilityLiveRegion="polite">{etaResult}</Text> : null}
          </Section>
        ) : null}

        <Section title="Notes">
          {visit.technicianNotes ? <Text style={type.body}>{visit.technicianNotes}</Text> : null}
          {visit.newNotes.map((n, i) => (
            <Text key={i} style={[type.body, { marginTop: space.xs }]}>
              {n.text}{n.waiting ? <Text style={styles.waiting}>  waiting to send</Text> : null}
            </Text>
          ))}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What you found"
            placeholderTextColor={color.inkFaint}
            multiline
            style={styles.note}
            accessibilityLabel="Note"
          />
          {note.trim() ? (
            <Button label="Save note" kind="secondary" onPress={() => {
              void field.record("visit.note", visit.id, { text: note.trim() });
              setNote("");
            }} />
          ) : null}
        </Section>

        <Section title="Photos">
          <Text style={type.soft}>
            {photoSummary(visit.photos)}
          </Text>
          {photoProblem ? <Notice tone="red">{photoProblem}</Notice> : null}
          <View style={{ marginTop: space.sm }}>
            <Button label="Take a photo" kind="secondary" onPress={async () => setPhotoProblem(await field.takePhoto(visit.id))} />
          </View>
        </Section>

        <Section title="Signature">
          <Text style={type.soft}>{visit.signed ? "Signed on this phone." : "Not signed yet."}</Text>
          <View style={{ marginTop: space.sm }}>
            <Button label={visit.signed ? "Sign again" : "Get a signature"} kind="secondary" onPress={() => nav.push({ name: "signature", visitId: visit.id })} />
          </View>
        </Section>

        <AskSection visit={visit} nav={nav} />
        <InspectionsSection visit={visit} nav={nav} />
        <ChecklistSection visit={visit} />
        <ReadingsSection visit={visit} />
        <PartsSection visit={visit} />
        <UnitSection visit={visit} />
        <SellSection visit={visit} nav={nav} />
        <InvoiceSection visit={visit} nav={nav} />
        <PaymentSection visit={visit} />
        <CashTipSection visit={visit} />
      </ScrollView>
    </View>
  );
}

export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.back} hitSlop={12}>
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <Text style={type.heading}>{title}</Text>
      <View style={styles.back} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: space.lg, minHeight: 52, borderBottomWidth: 1, borderBottomColor: color.line,
    backgroundColor: color.canvas,
  },
  back: { minWidth: 64, minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 17, color: color.blue },
  warn: { fontSize: 16, fontWeight: "600", color: color.amber },
  warnText: { fontSize: 16, color: color.amber, marginTop: space.xs },
  code: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontWeight: "700" },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  address: { marginTop: space.sm, color: color.blue },
  step: { marginVertical: space.xl },
  etaRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm },
  eta: { minWidth: 48, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: color.line, alignItems: "center", justifyContent: "center", backgroundColor: color.canvas },
  etaOn: { backgroundColor: color.ink, borderColor: color.ink },
  etaText: { fontSize: 16, fontWeight: "600", color: color.ink },
  note: {
    minHeight: 80, borderWidth: 1, borderColor: color.line, borderRadius: 8, padding: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.sm, textAlignVertical: "top",
  },
  waiting: { color: color.amber, fontSize: 13 },
});
