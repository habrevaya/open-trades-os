import { StyleSheet, Text, View } from "react-native";
import { customerNoteLine, customerNotesToShow, type DayVisit } from "@opentradesos/field-client";
import { Section } from "../components/ui";
import { color, space, type } from "../components/theme";

/**
 * NOTES FROM THE OFFICE, ON THE VISIT
 *
 * What the office learned about this customer and marked for whoever goes out
 * ("gate sticks, lift and push"). Pinned ones first, then the newest, so the one
 * thing the office wants said is the first thing read. They ride in the day, so
 * they are here with no signal. Read only: a note is written and fixed in the
 * office, and the customer's other notes never reach the phone. The section is
 * absent when the office marked none.
 */
export function CustomerNotesSection({ visit, zone }: { visit: DayVisit; zone: string }) {
  const notes = customerNotesToShow(visit.customerNotes);
  if (notes.length === 0) return null;
  return (
    <Section title="Notes from the office">
      {notes.map((note) => (
        <View key={note.id} style={[styles.note, note.pinned && styles.pinned]}>
          <Text style={type.body}>{note.body}</Text>
          <Text style={[type.soft, { marginTop: space.xs }]}>{customerNoteLine(note, zone)}</Text>
        </View>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: space.sm, paddingLeft: space.sm, borderLeftWidth: 3, borderLeftColor: color.line },
  pinned: { borderLeftColor: color.ink },
});
