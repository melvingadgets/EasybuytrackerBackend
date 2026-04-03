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
  UserEmail:{type:String,required:true}
}, { timestamps: true })      
export default mongoose.model<Ieasyboughtitem>("easyboughtitem", EasyBoughtItemSchema); 
