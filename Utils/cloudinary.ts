import cloud, { v2 } from "cloudinary";
const cloudinary: typeof v2 = cloud.v2;

cloudinary.config({
  cloud_name: "djcjonq79",
  api_key: "743338794996375",
  api_secret: "ouWYRaS1hz_eaPAnEg3rvbdVIzQ",
});
export default cloudinary;
