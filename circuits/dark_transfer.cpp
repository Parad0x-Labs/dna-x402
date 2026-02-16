#include "circom.hpp"
#include "calcwit.hpp"
#define NSignals 10
#define NComponents 1
#define NOutputs 0
#define NInputs 9
#define NVars 10
#define NPublic 9
#define __P__ "21888242871839275222246405745257275088548364400416034343698204186575808495617"

/*
DarkTransfer
*/
void DarkTransfer_7f969b05035d55a6(Circom_CalcWit *ctx, int __cIdx) {
    FrElement _sigValue[1];
    FrElement _sigValue_1[1];
    FrElement _tmp[1];
    FrElement _sigValue_2[1];
    FrElement _sigValue_3[1];
    FrElement _tmp_1[1];
    FrElement _sigValue_4[1];
    FrElement _sigValue_5[1];
    FrElement _sigValue_6[1];
    FrElement _sigValue_7[1];
    FrElement _tmp_2[1];
    FrElement _sigValue_8[1];
    FrElement _sigValue_9[1];
    int _nullifierHash_Asset_sigIdx_;
    int _secret_Asset_sigIdx_;
    int _nullifierHash_Fee_sigIdx_;
    int _secret_Fee_sigIdx_;
    int _amount_Fee_sigIdx_;
    int _root_sigIdx_;
    int _assetIdHash_sigIdx_;
    int _amount_Asset_sigIdx_;
    _nullifierHash_Asset_sigIdx_ = ctx->getSignalOffset(__cIdx, 0x09b2af90b38db5daLL /* nullifierHash_Asset */);
    _secret_Asset_sigIdx_ = ctx->getSignalOffset(__cIdx, 0x0180ab9727754c7eLL /* secret_Asset */);
    _nullifierHash_Fee_sigIdx_ = ctx->getSignalOffset(__cIdx, 0xf9bd669f1d400276LL /* nullifierHash_Fee */);
    _secret_Fee_sigIdx_ = ctx->getSignalOffset(__cIdx, 0x61af2e1608d0de22LL /* secret_Fee */);
    _amount_Fee_sigIdx_ = ctx->getSignalOffset(__cIdx, 0x7d8c65f62b59bf0aLL /* amount_Fee */);
    _root_sigIdx_ = ctx->getSignalOffset(__cIdx, 0xa354fd1ff0c467c5LL /* root */);
    _assetIdHash_sigIdx_ = ctx->getSignalOffset(__cIdx, 0xa86d5a8ab983cf7aLL /* assetIdHash */);
    _amount_Asset_sigIdx_ = ctx->getSignalOffset(__cIdx, 0x5371b22e6f10e046LL /* amount_Asset */);
    /* signal input root */
    /* signal input nullifierHash_Asset */
    /* signal input nullifierHash_Fee */
    /* signal input commitment_New */
    /* signal input assetIdHash */
    /* signal input secret_Asset */
    /* signal input amount_Asset */
    /* signal input secret_Fee */
    /* signal input amount_Fee */
    /* nullifierHash_Asset === secret_Asset + 111 */
    ctx->multiGetSignal(__cIdx, __cIdx, _nullifierHash_Asset_sigIdx_, _sigValue, 1);
    ctx->multiGetSignal(__cIdx, __cIdx, _secret_Asset_sigIdx_, _sigValue_1, 1);
    Fr_add(_tmp, _sigValue_1, (ctx->circuit->constants + 2));
    ctx->checkConstraint(__cIdx, _sigValue, _tmp, "G:\dark $NULL\pdx_dark_protocol\circuits\dark_transfer.circom:19:4");
    /* nullifierHash_Fee === secret_Fee + 222 */
    ctx->multiGetSignal(__cIdx, __cIdx, _nullifierHash_Fee_sigIdx_, _sigValue_2, 1);
    ctx->multiGetSignal(__cIdx, __cIdx, _secret_Fee_sigIdx_, _sigValue_3, 1);
    Fr_add(_tmp_1, _sigValue_3, (ctx->circuit->constants + 3));
    ctx->checkConstraint(__cIdx, _sigValue_2, _tmp_1, "G:\dark $NULL\pdx_dark_protocol\circuits\dark_transfer.circom:20:4");
    /* amount_Fee === 1000000000 */
    ctx->multiGetSignal(__cIdx, __cIdx, _amount_Fee_sigIdx_, _sigValue_4, 1);
    ctx->checkConstraint(__cIdx, _sigValue_4, (ctx->circuit->constants + 4), "G:\dark $NULL\pdx_dark_protocol\circuits\dark_transfer.circom:23:4");
    /* root === secret_Asset + secret_Fee */
    ctx->multiGetSignal(__cIdx, __cIdx, _root_sigIdx_, _sigValue_5, 1);
    ctx->multiGetSignal(__cIdx, __cIdx, _secret_Asset_sigIdx_, _sigValue_6, 1);
    ctx->multiGetSignal(__cIdx, __cIdx, _secret_Fee_sigIdx_, _sigValue_7, 1);
    Fr_add(_tmp_2, _sigValue_6, _sigValue_7);
    ctx->checkConstraint(__cIdx, _sigValue_5, _tmp_2, "G:\dark $NULL\pdx_dark_protocol\circuits\dark_transfer.circom:26:4");
    /* assetIdHash === amount_Asset */
    ctx->multiGetSignal(__cIdx, __cIdx, _assetIdHash_sigIdx_, _sigValue_8, 1);
    ctx->multiGetSignal(__cIdx, __cIdx, _amount_Asset_sigIdx_, _sigValue_9, 1);
    ctx->checkConstraint(__cIdx, _sigValue_8, _sigValue_9, "G:\dark $NULL\pdx_dark_protocol\circuits\dark_transfer.circom:29:4");
    ctx->finished(__cIdx);
}
// Function Table
Circom_ComponentFunction _functionTable[1] = {
     DarkTransfer_7f969b05035d55a6
};
