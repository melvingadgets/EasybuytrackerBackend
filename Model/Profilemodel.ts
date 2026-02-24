import mongoose from "mongoose"

interface profile{
    FullName: string;
    Gender: string;
    Address: string;
    Avatar: string;
    

}
interface Iprofile extends profile, mongoose.Document { }

const ProfileSchema = new mongoose.Schema(
    {
        Gender: {
            type:String
        },
        FullName: {
            type:String
        },
        Address: {
            type:String
        },
        Avatar:{
            type:String
        }
    },
    {timestamps:true}
    
)
export default mongoose.model<Iprofile>("profile",ProfileSchema)