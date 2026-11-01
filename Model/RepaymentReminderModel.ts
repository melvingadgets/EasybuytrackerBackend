import mongoose from "mongoose";

// One document per reminder sent (Shortwork/docs/notifications.md §13). The unique index is what
// makes a reminder exactly-once (Shortwork/AGENTS.md §3.8): the job never asks whether one exists
// before writing, it writes and lets the database refuse a second. The document and its
// easybuy.repayment.due event commit in one transaction (§3.1), so neither exists without the other.
//
// Never expired: a reminder's record is what stops that reminder going out again.

export const REMINDER_STAGES = ["upcoming", "due", "overdue"] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

interface RepaymentReminder {
  itemId: mongoose.Types.ObjectId;
  instalment: number;
  stage: ReminderStage;
  personId: string;
  /** Calendar date in Africa/Lagos, YYYY-MM-DD. */
  dueOn: string;
  amountKobo: number;
  eventId: string;
  createdAt?: Date;
}

const RepaymentReminderSchema = new mongoose.Schema<RepaymentReminder>(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "easyboughtitem", required: true },
    instalment: { type: Number, required: true, min: 1 },
    stage: { type: String, enum: REMINDER_STAGES, required: true },
    personId: { type: String, required: true },
    dueOn: { type: String, required: true },
    amountKobo: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "amountKobo must be integer kobo" },
    },
    eventId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

RepaymentReminderSchema.index({ itemId: 1, instalment: 1, stage: 1 }, { unique: true });

export default mongoose.model<RepaymentReminder>("repaymentreminder", RepaymentReminderSchema);
