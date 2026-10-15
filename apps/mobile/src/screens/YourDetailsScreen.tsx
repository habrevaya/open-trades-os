import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  addressLine, contactBody, contactChanged, contactFormOf, EMPTY_CONTACT_FORM, phoneWords,
  type OwnContactForm, type OwnContactRecord,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { Button, Card, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import { Header } from "./VisitScreen";
import type { Navigate } from "../shell/App";

/**
 * YOUR PHONE AND ADDRESS
 *
 * The person's own phone number and home address, the same record `/me` keeps:
 * the office reads it and sees what changed and when, and cannot write it. Sent
 * whole each time (an empty box takes that part off) and NOT queued: a number
 * that does not dial is told to the person now, in the server's own words,
 * while they are holding the phone. It needs a signal for that reason, and
 * says so rather than keeping a change it cannot check.
 */
export function YourDetailsScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const [record, setRecord] = useState<OwnContactRecord | null>(null);
  const [form, setForm] = useState<OwnContactForm>(EMPTY_CONTACT_FORM);
  const [loading, setLoading] = useState(true);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { loadContact } = field;
  useEffect(() => {
    let current = true;
    void loadContact().then((loaded) => {
      if (!current) return;
      setLoading(false);
      if ("problem" in loaded) { setLoadProblem(loaded.problem); return; }
      setRecord(loaded);
      setForm(contactFormOf(loaded));
    });
    return () => { current = false; };
  }, [loadContact]);

  const edit = (key: keyof OwnContactForm) => (text: string) => {
    setSaved(false);
    setForm((now) => ({ ...now, [key]: text }));
  };

  const save = async () => {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    const result = await field.saveContact(contactBody(form));
    setSaving(false);
    if ("problem" in result) { setProblem(result.problem); return; }
    setRecord(result);
    setForm(contactFormOf(result));
    setSaved(true);
  };

  const kept = addressLine(record);
  return (
    <View style={styles.root}>
      <Header onBack={nav.back} title="Your phone and address" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={type.soft}>
          Keep these right yourself, so the office can reach you and mail you what you need. When you change them,
          the office sees what changed and when. Leave a box empty to take it off.
        </Text>
        {loadProblem ? <Notice tone="red">{loadProblem}</Notice> : null}
        {loading ? <Text style={type.soft}>Loading</Text> : null}
        {!loading && !loadProblem ? (
          <>
            {record?.contact ? (
              <Card>
                <Text style={type.label}>On file now</Text>
                <Text style={type.body}>{record.contact.phone ? phoneWords(record.contact.phone) : "No phone number"}</Text>
                <Text style={type.body}>{kept ?? "No address"}</Text>
              </Card>
            ) : null}
            <Field label="Your phone number" value={form.phone} onChangeText={edit("phone")}
                   keyboardType="phone-pad" maxLength={40} placeholder="(512) 555-0143" />
            <Field label="Street" value={form.addressLine1} onChangeText={edit("addressLine1")} maxLength={120}
                   autoCapitalize="words" />
            <Field label="Apartment or unit (if any)" value={form.addressLine2} onChangeText={edit("addressLine2")}
                   maxLength={120} autoCapitalize="words" />
            <Field label="Town" value={form.city} onChangeText={edit("city")} maxLength={100} autoCapitalize="words" />
            <Field label="State (two letters)" value={form.state} onChangeText={edit("state")} maxLength={2}
                   autoCapitalize="characters" placeholder="TX" />
            <Field label="ZIP code" value={form.postalCode} onChangeText={edit("postalCode")} maxLength={10}
                   keyboardType="number-pad" />
            {problem ? <Notice tone="red">{problem}</Notice> : null}
            {saved ? <Notice tone="green">Saved. The office can see this now.</Notice> : null}
            <Button label="Save" busy={saving} disabled={!contactChanged(form, record)} onPress={() => void save()} />
            <Text style={type.soft}>This needs a signal, so a number that does not dial is told to you now.</Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 3, gap: space.sm },
});
