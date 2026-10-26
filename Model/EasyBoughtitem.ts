import mongoose from "mongoose";


interface easyboughtitem {
    provider: string;
    IphoneModel: string;
    IphoneImageUrl: string;
    capacity: string;
    Plan:string;
    downPayment:number;
    loanedAmount:number;
    PhonePrice: number;
    weeklyPlan?: number;
    monthlyPlan?: number;
   UserId: mongoose.Types.ObjectId;
   UserEmail:string;
   serviceFeeKobo?: number;
   serviceFeeBps?: number;
   serviceFeeBase?: "financed" | "price";
   personId?: string;
   sourceRequestId?: string;
   createdAt?: Date;
   updatedAt?: Date;
}


interface Ieasyboughtitem extends easyboughtitem, mongoose.Document { }

const EasyBoughtItemSchema = new mongoose.Schema({
  provider: { type: String, default: "aurapay", trim: true, index: true },
  IphoneModel: { type: String, required: true },
  IphoneImageUrl: { type: String, required: true },
  capacity: { type: String, required: true },
 Plan:{type:String,enum:["Monthly","Weekly"],required:true},
  downPayment:{type: Number, required:true},
  loanedAmount:{type: Number, required:true},
  PhonePrice: { type: Number, required: true },
  monthlyPlan:{type:Number},
  weeklyPlan:{type:Number},
  UserId:{type:mongoose.Types.ObjectId,ref:"User",required:true},
  UserEmail:{type:String,required:true},
  // The EasyBuy service charge, fixed when the item is created (RESELLER-PLAN.md §8b). Integer
  // kobo, unlike the older naira fields above. Absent on items created before the charge existed.
  serviceFeeKobo:{type:Number,validate:{validator:Number.isSafeInteger,message:"serviceFeeKobo must be integer kobo"}},
  serviceFeeBps:{type:Number,min:0,max:10000},
  serviceFeeBase:{type:String,enum:["financed","price"]},
  // The platform person (auth user _id) and the Apply request it came from, when known. No default:
  // a missing value is simply absent, so the partial index below never sees an explicit null.
  personId:{type:String,trim:true},
  sourceRequestId:{type:String,trim:true},
}, { timestamps: true })
EasyBoughtItemSchema.index({ personId: 1 }, { partialFilterExpression: { personId: { $type: "string" } } });
export default mongoose.model<Ieasyboughtitem>("easyboughtitem", EasyBoughtItemSchema); 
