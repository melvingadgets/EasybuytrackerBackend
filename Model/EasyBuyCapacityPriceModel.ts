import mongoose from "mongoose";

type EasyBuyCapacityPrice = {
  model: string;
  capacity: string;
  price: number;
  updatedBy?: mongoose.Types.ObjectId;
};

const EasyBuyCapacityPriceSchema = new mongoose.Schema<EasyBuyCapacityPrice>(
  {
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

EasyBuyCapacityPriceSchema.index({ model: 1, capacity: 1 }, { unique: true });

type IEasyBuyCapacityPrice = mongoose.InferSchemaType<typeof EasyBuyCapacityPriceSchema>;

export default mongoose.model<IEasyBuyCapacityPrice>(
  "easybuycapacityprice",
  EasyBuyCapacityPriceSchema
);
