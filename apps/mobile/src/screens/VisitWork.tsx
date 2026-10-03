import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  formatAmount, isOwing, outOfRange, parseAmount, readingValue,
  type DayReportField, type DayVisit,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { missingReadings, parseQuantity, searchPriceBook } from "../lib/work";
import { Button, Card, Notice, Section } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * THE WORK ON A VISIT
 *
 * The checklist, the readings the job type asks for, the parts used and the
 * money taken. Every one is an operation in the queue on this phone, sent
 * when there is signal, and drawn from the queue so it is still there after
 * the app is killed in a basement. "Waiting to send" beside a line means it
 * is on this phone and not yet at the office.
 */

const waitingText = <Text style={{ color: color.amber, fontSize: 13 }}>  waiting to send</Text>;

export function ChecklistSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  if (visit.checklist.length === 0) return null;
  return (
    <Section title="Checklist">
      <Card>
        {visit.checklist.map((item) => {
          const done = item.doneAt !== null;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: done }}
              accessibilityLabel={`${item.label}${item.required ? ", required" : ""}`}
              onPress={() => void field.record("visit.checklist_item", visit.id, { itemId: item.id, done: !done })}
              style={styles.check}
            >
              <View style={[styles.box, done && styles.boxOn]}>{done ? <Text style={styles.tick}>✓</Text> : null}</View>
              <Text style={[type.body, { flex: 1 }]}>
                {item.label}{item.required ? " (required)" : ""}{item.waiting ? waitingText : null}
              </Text>
            </Pressable>
          );
        })}
      </Card>
    </Section>
  );
}

/**
 * The service report, as the job type's template asks for it. The report's
 * id is made on this phone the first time a reading is saved, the same way
 * the phone makes every other id it needs offline, and the readings after it
 * name the same report because the day is drawn from the queue.
 */
export function ReadingsSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const report = visit.report;
  if (report.fields.length === 0) return null;

  const reportId = () => report.id ?? Crypto.randomUUID();
  const submit = () => {
    const missing = missingReadings(report.fields);
    const send = () => void field.record("service_report.submit", reportId(), { visitId: visit.id });
    Alert.alert(
      "Send the report to the office?",
      missing.length > 0
        ? `Still empty: ${missing.join(", ")}. You cannot change it after it is sent.`
        : "You cannot change it after it is sent.",
      [{ text: "Not yet", style: "cancel" }, { text: "Send it", onPress: send }],
    );
  };

  return (
    <Section title="Readings">
      {report.submitted ? (
        <Notice tone="green">
          {report.submitWaiting ? "Sent from this phone, waiting for signal." : "Sent to the office."}
        </Notice>
      ) : null}
      {report.fields.map((f) => (
        <Reading key={f.key} field={f} locked={report.submitted}
                 onSave={(payload) => field.record("service_report.set_field", reportId(), { visitId: visit.id, ...payload })} />
      ))}
      {!report.submitted ? <Button label="Send the report to the office" kind="secondary" onPress={submit} /> : null}
    </Section>
  );
}

function Reading({ field, locked, onSave }: {
  field: DayReportField;
  locked: boolean;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [chemical, setChemical] = useState({ product: "", epa: "", quantity: "", unit: field.unit ?? "" });
  const [problem, setProblem] = useState<string | null>(null);
  const base = { field: field.key, label: field.label, kind: field.kind, ...(field.unit ? { unit: field.unit } : {}) };

  const save = async (raw: string) => {
    const value = readingValue(field, raw);
    if (value === null) {
      setProblem(field.kind === "numeric" || field.kind === "measurement" ? "Enter a number." : "Choose or type a value.");
      return;
    }
    setProblem(outOfRange(field, value) ? `Saved, and outside the usual ${field.min ?? ""} to ${field.max ?? ""}. Check it.` : null);
    await onSave({ ...base, value });
    setTyped("");
  };

  const saveChemical = async () => {
    if (chemical.product.trim() === "" || parseQuantity(chemical.quantity) === null) {
      setProblem("Enter the product and how much was applied.");
      return;
    }
    setProblem(null);
    await onSave({
      ...base,
      value: chemical.product.trim(),
      productName: chemical.product.trim(),
      ...(chemical.epa.trim() ? { epaRegistrationNumber: chemical.epa.trim() } : {}),
      quantityApplied: parseQuantity(chemical.quantity),
      ...(chemical.unit.trim() ? { applicationUnit: chemical.unit.trim() } : {}),
    });
    setChemical({ product: "", epa: "", quantity: "", unit: field.unit ?? "" });
  };

  const choices = field.kind === "boolean" ? ["Yes", "No"] : field.kind === "select" ? field.options : null;

  return (
    <View style={styles.reading}>
      <Text style={type.heading}>
        {field.label}{field.unit ? ` (${field.unit})` : ""}{field.required ? " *" : ""}
      </Text>
      <Text style={type.soft}>
        {field.value !== null ? `Recorded: ${field.value}` : "Nothing recorded yet."}{field.waiting ? waitingText : null}
      </Text>
      {locked ? null : choices ? (
        <View style={styles.chips}>
          {choices.map((choice) => (
            <Pressable key={choice} accessibilityRole="button" accessibilityLabel={`${field.label}: ${choice}`}
                       onPress={() => void save(choice)} style={styles.chip}>
              <Text style={styles.chipText}>{choice}</Text>
            </Pressable>
          ))}
        </View>
      ) : field.kind === "chemical" ? (
        <View>
          <TextInput value={chemical.product} onChangeText={(product) => setChemical({ ...chemical, product })}
                     placeholder="Product" placeholderTextColor={color.inkFaint} style={styles.input} accessibilityLabel="Product" />
          <TextInput value={chemical.epa} onChangeText={(epa) => setChemical({ ...chemical, epa })}
                     placeholder="EPA registration number" placeholderTextColor={color.inkFaint} style={styles.input}
                     accessibilityLabel="EPA registration number" />
          <View style={styles.row}>
            <TextInput value={chemical.quantity} onChangeText={(quantity) => setChemical({ ...chemical, quantity })}
                       placeholder="Amount" keyboardType="decimal-pad" placeholderTextColor={color.inkFaint}
                       style={[styles.input, { flex: 1 }]} accessibilityLabel="Amount applied" />
            <TextInput value={chemical.unit} onChangeText={(unit) => setChemical({ ...chemical, unit })}
                       placeholder="Unit" placeholderTextColor={color.inkFaint}
                       style={[styles.input, { flex: 1 }]} accessibilityLabel="Unit" />
          </View>
          <Button label="Save" kind="secondary" onPress={() => void saveChemical()} />
        </View>
      ) : (
        <View style={styles.row}>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            keyboardType={field.kind === "numeric" || field.kind === "measurement" ? "decimal-pad" : "default"}
            placeholder={field.value ?? ""}
            placeholderTextColor={color.inkFaint}
            style={[styles.input, { flex: 1 }]}
            accessibilityLabel={field.label}
            returnKeyType="done"
            onSubmitEditing={() => void save(typed)}
          />
          <View style={{ width: 96 }}>
            <Button label="Save" kind="secondary" onPress={() => void save(typed)} disabled={typed.trim() === ""} />
          </View>
        </View>
      )}
      {problem ? <Text style={styles.problem} accessibilityLiveRegion="polite">{problem}</Text> : null}
    </View>
  );
}

/**
 * Parts used, picked from the price book the phone already holds, or typed
 * when it is not in there, which the office then prices. A job line, not an
 * invoice line: what reaches the customer's bill is the office's decision.
 */
export function PartsSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const priceBook = field.view?.priceBook ?? [];
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [problem, setProblem] = useState<string | null>(null);
  const matches = searchPriceBook(priceBook, query);

  const add = async (payload: Record<string, unknown>) => {
    const qty = parseQuantity(quantity);
    if (!qty) {
      setProblem("Enter how many, like 1 or 2.5.");
      return;
    }
    setProblem(null);
    await field.record("visit.add_line", visit.id, { kind: "part", quantity: qty, ...payload });
    setQuery("");
    setQuantity("1");
  };

  return (
    <Section title="Parts used">
      {visit.parts.length === 0
        ? <Text style={type.soft}>No parts recorded on this visit.</Text>
        : visit.parts.map((part) => (
          <Text key={part.id} style={type.body}>
            {Number(part.quantity)} x {part.name}{part.waiting ? waitingText : null}
          </Text>
        ))}
      <View style={[styles.row, { marginTop: space.sm }]}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Find a part" placeholderTextColor={color.inkFaint}
                   style={[styles.input, { flex: 3 }]} accessibilityLabel="Find a part" />
        <TextInput value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad"
                   style={[styles.input, { flex: 1 }]} accessibilityLabel="How many" />
      </View>
      {matches.map((item) => (
        <Pressable key={item.versionId} accessibilityRole="button" accessibilityLabel={`Add ${item.name}`}
                   onPress={() => void add({
                     priceBookItemVersionId: item.versionId, name: item.name,
                     unitPrice: item.unitPrice, taxable: item.taxable,
                   })}
                   style={styles.match}>
          <Text style={type.body}>{item.code ? `${item.code}  ` : ""}{item.name}</Text>
          <Text style={type.soft}>{formatAmount(item.unitPrice)}</Text>
        </Pressable>
      ))}
      {query.trim() !== "" ? (
        <Button label={`Add "${query.trim()}", not in the price book`} kind="secondary"
                onPress={() => void add({ name: query.trim().slice(0, 200), unitPrice: "0" })} />
      ) : null}
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
    </Section>
  );
}

/**
 * Money taken on site. Cash and checks are recorded through the queue,
 * because the money is in the technician's hand whether or not there is a
 * signal; a card goes through the invoice's own payment link, which the
 * customer pays on their own phone.
 */
export function PaymentSection({ visit }: { visit: DayVisit }) {
  const field = useField();
  const owing = isOwing(visit.amountDue);
  const [method, setMethod] = useState<"cash" | "check" | "card">("cash");
  const [amount, setAmount] = useState(owing ? formatAmount(visit.amountDue!).replace(/[$,]/g, "") : "");
  const [checkNumber, setCheckNumber] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const record = async () => {
    const parsed = parseAmount(amount);
    if (!parsed) return setProblem("Enter the amount they paid, like 120 or 120.50.");
    if (method === "check" && checkNumber.trim() === "") return setProblem("Enter the check number, so the office can match it to the bank.");
    setProblem(null);
    await field.record("payment.collect", visit.id, {
      method, amount: parsed, ...(method === "check" ? { checkNumber: checkNumber.trim() } : {}),
    });
    setCheckNumber("");
  };

  const link = async (how: "text" | "share") => {
    setBusy(true);
    setSaid(await field.paymentLink(visit.id, how));
    setBusy(false);
  };

  return (
    <Section title="Payment">
      <Text style={type.body}>
        {visit.amountDue === null
          ? "Nothing invoiced for this job yet. Cash or a check is held for the customer until the office applies it."
          : owing ? `Owed on this job: ${formatAmount(visit.amountDue)}` : "Nothing owed on this job."}
      </Text>
      <View style={styles.chips}>
        {(["cash", "check", "card"] as const).map((m) => (
          <Pressable key={m} accessibilityRole="radio" accessibilityState={{ selected: method === m }}
                     onPress={() => { setMethod(m); setProblem(null); setSaid(null); }}
                     style={[styles.chip, method === m && styles.chipOn]}>
            <Text style={[styles.chipText, method === m && { color: "#fff" }]}>
              {m === "cash" ? "Cash" : m === "check" ? "Check" : "Card"}
            </Text>
          </Pressable>
        ))}
      </View>
      {method === "card" ? (
        <View>
          <Button label="Text them a card link" kind="secondary" busy={busy} onPress={() => void link("text")} />
          <View style={{ marginTop: space.sm }}>
            <Button label="Share the link" kind="secondary" disabled={busy} onPress={() => void link("share")} />
          </View>
        </View>
      ) : (
        <View>
          <View style={styles.row}>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount"
                       placeholderTextColor={color.inkFaint} style={[styles.input, { flex: 1 }]} accessibilityLabel="Amount" />
            {method === "check" ? (
              <TextInput value={checkNumber} onChangeText={setCheckNumber} keyboardType="number-pad" placeholder="Check no."
                         placeholderTextColor={color.inkFaint} style={[styles.input, { flex: 1 }]} accessibilityLabel="Check number" />
            ) : null}
          </View>
          <Button label={method === "cash" ? "Record cash payment" : "Record check payment"} kind="secondary"
                  onPress={() => void record()} />
        </View>
      )}
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      {said ? <Text style={[type.soft, { marginTop: space.sm }]} accessibilityLiveRegion="polite">{said}</Text> : null}
      {visit.payments.map((p) => (
        <Text key={p.clientId} style={[type.body, { marginTop: space.xs }]}>
          {p.method === "cash" ? "Cash" : `Check ${p.checkNumber ?? ""}`.trim()} {formatAmount(p.amount)}
          {p.waiting ? waitingText : <Text style={type.soft}>  sent</Text>}
        </Text>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  check: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48 },
  box: { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: color.ink, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: color.ink },
  tick: { color: "#fff", fontWeight: "700", fontSize: 16 },
  reading: { marginBottom: space.lg },
  row: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: 8, paddingHorizontal: space.md,
    fontSize: 16, color: color.ink, backgroundColor: color.canvas, marginVertical: space.xs,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginVertical: space.sm },
  chip: {
    minWidth: 64, minHeight: 44, paddingHorizontal: space.md, borderRadius: 8, borderWidth: 1, borderColor: color.line,
    alignItems: "center", justifyContent: "center", backgroundColor: color.canvas,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { fontSize: 16, fontWeight: "600", color: color.ink },
  match: {
    flexDirection: "row", justifyContent: "space-between", minHeight: 48, alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: color.line,
  },
  problem: { color: color.red, fontSize: 15, marginTop: space.xs },
});
