import mongoose from "mongoose";

type EasyBuyCapacityPrice = {
  provider: string;
  model: string;
  capacity: string;
  price: number;
  updatedBy?: mongoose.Types.ObjectId;
};

const EasyBuyCapacityPriceSchema = new mongoose.Schema<EasyBuyCapacityPrice>(
  {
    provider: {
      type: String,
      required: true,
      default: "aurapay",
      trim: true,
      index: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    capacity: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0.01,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
  },
  { timestamps: true }
);

EasyBuyCapacityPriceSchema.index({ provider: 1, model: 1, capacity: 1 }, { unique: true });

type IEasyBuyCapacityPrice = mongoose.InferSchemaType<typeof EasyBuyCapacityPriceSchema>;

export default mongoose.model<IEasyBuyCapacityPrice>(
  "easybuycapacityprice",
  EasyBuyCapacityPriceSchema
);
