import mongoose from "mongoose";


interface easyboughtitem {
    IphoneModel: string;
    IphoneImageUrl: string;
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
  IphoneModel: { type: String, required: true },
  IphoneImageUrl: { type: String, required: true },
 Plan:{type:String,enum:["Monthly","Weekly"],required:true},
  downPayment:{type: Number, required:true},
  loanedAmount:{type: Number, required:true},
  PhonePrice: { type: Number, required: true },
  monthlyPlan:{type:Number, enum:[1,2,3]},
  weeklyPlan:{type:Number, enum:[4,8,12],},
  UserId:{type:mongoose.Types.ObjectId,ref:"User",required:true},
  UserEmail:{type:String,required:true}
}, { timestamps: true })      
export default mongoose.model<Ieasyboughtitem>("easyboughtitem", EasyBoughtItemSchema); 
