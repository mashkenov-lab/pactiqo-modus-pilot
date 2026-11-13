class MessagingV2Client{
 constructor({rpc}){if(typeof rpc!=='function')throw Error('MESSAGING_RPC_REQUIRED');this.rpc=rpc;}
 status(){return this.rpc('adapter_messaging_v2_status',{});}
 poll(p={}){return this.rpc('adapter_messaging_v2_poll',p);}
 ack(p){return this.rpc('adapter_messaging_v2_ack',p);}
 progress(p){return this.rpc('adapter_messaging_v2_progress',p);}
 progressReceipt(p){return this.rpc('adapter_messaging_v2_progress_receipt',p);}
 reply(p){return this.rpc('adapter_messaging_v2_reply',p);}
 receipt(p){return this.rpc('adapter_messaging_v2_receipt',p);}
 prepareBinding(p){return this.rpc('adapter_messaging_v2_binding_prepare',p);}
 bindingProof(p){return this.rpc('adapter_messaging_v2_binding_proof',p);}
 confirmBinding(p){return this.rpc('adapter_messaging_v2_binding_confirm',p);}
 revokeBinding(p){return this.rpc('adapter_messaging_v2_binding_revoke',p);}
 caseState(p){return this.rpc('adapter_messaging_v2_case_state',p);}
 linkCase(p){return this.rpc('adapter_messaging_v2_case_link',p);}
 notify(p){return this.rpc('adapter_messaging_v2_notify',p);}
 importMail(p){return this.rpc('adapter_messaging_v2_mail_import',p);}
}
module.exports={MessagingV2Client};
