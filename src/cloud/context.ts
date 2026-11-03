import { createContext, useContext } from 'react'
export interface CloudContextValue {available:boolean;user:string|null;status:string;error:string;pending:number;open:()=>void;sync:()=>void}
export const CloudContext=createContext<CloudContextValue>({available:false,user:null,status:'Хранится на этом устройстве',error:'',pending:0,open:()=>{},sync:()=>{}})
export const useCloud=()=>useContext(CloudContext)
