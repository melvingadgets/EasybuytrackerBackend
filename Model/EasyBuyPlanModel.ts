import mongoose from "mongoose";

interface EasyBuyPlan {
  user: mongoose.Types.ObjectId;
  totalAmount: number;
  startDate: Date;
  endDate?: Date;
}

interface IEasyBuyPlan extends EasyBuyPlan, mongoose.Document {}

const EasyBuyPlanSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
    },
  },
  { timestamps: true }
);

EasyBuyPlanSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model<IEasyBuyPlan>("easybuyplan", EasyBuyPlanSchema);
