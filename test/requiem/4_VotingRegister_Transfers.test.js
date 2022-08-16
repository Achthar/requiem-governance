/* eslint-disable */

const { BN, constants: ozConstants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');
const {
  // MAX_UINT256, 
  ZERO_ADDRESS, ZERO_BYTES32 } = ozConstants;

const { fromRpcSig } = require('ethereumjs-util');
const ethSigUtil = require('eth-sig-util');
const Wallet = require('ethereumjs-wallet').default;

const { promisify } = require('util');
const queue = promisify(setImmediate);

const ERC20VotesMock = artifacts.require('GovernanceRequiemMock');
const MockRegisteredToken = artifacts.require('MockRegisteredToken');
const VotingRegister = artifacts.require('MockVotesRegister');
const ERC20Mock = artifacts.require('ERC20Mock');


const { EIP712Domain, domainSeparator } = require('../helpers/eip712');
const { ethers } = require('hardhat');
const { BigNumber, constants } = require('ethers');

const Delegation = [
  { name: 'delegatee', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
];

async function countPendingTransactions() {
  return parseInt(
    await network.provider.send('eth_getBlockTransactionCountByNumber', ['pending'])
  );
}

async function batchInBlock(txs) {
  try {
    // disable auto-mining
    await network.provider.send('evm_setAutomine', [false]);
    // send all transactions
    const promises = txs.map(fn => fn());
    // wait for node to have all pending transactions
    while (txs.length > await countPendingTransactions()) {
      await queue();
    }
    // mine one block
    await network.provider.send('evm_mine');
    // fetch receipts
    const receipts = await Promise.all(promises);
    // Sanity check, all tx should be in the same block
    const minedBlocks = new Set(receipts.map(({ receipt }) => receipt.blockNumber));
    expect(minedBlocks.size).to.equal(1);

    return receipts;
  } finally {
    // enable auto-mining
    await network.provider.send('evm_setAutomine', [true]);
  }
}

contract('Requiem Votes Register: Events on transfer', function (accounts) {
  // const [deployer.address, dave.address, alice.address, dave.addressDelegatee, bob.address, carol.address] = accounts;
  let deployer, alice, bob, carol, dave;
  const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1)
  const name = 'My Token';
  const symbol = 'MTKN';
  const version = '1';
  const supply = BigNumber.from('10000000000000000000000000');

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    const factoryToken = await ethers.getContractFactory('MockRegisteredToken')
    const factoryRegister = await ethers.getContractFactory('MockVotesRegister')

    this.register = await factoryRegister.deploy()
    this.token1 = await factoryToken.deploy(name, symbol, this.register.address)

    this.lockedToken = await ERC20Mock.new(name, symbol, deployer.address, supply);
    // this.register = await VotingRegister.new({ from: deployer.address })
    // this.token1 = await MockRegisteredToken.new(name, symbol, this.register.address);
    await this.register.authorize(deployer.address, { from: deployer.address })
    await this.register.registerToken(this.token1.address, { from: deployer.address })

    // We get the chain id from the contract because Ganache (used for coverage) does not return the same chain id
    // from within the EVM as from the JSON RPC interface.
    // See https://github.com/trufflesuite/ganache-core/issues/515
    this.chainId = await this.register.getChainId();
  });

  it('initial nonce is 0', async function () {
    expect((await this.register.nonces(deployer.address)).toString()).to.be.equal('0');
  });


  describe('transfers', function () {
    beforeEach(async function () {
      await this.token1.mint(deployer.address, supply);
    });

    it('no delegation', async function () {
      expect(await this.token1.connect(deployer).transfer(dave.address, 1)
      ).to.emit('Transfer').withArgs(
        deployer.address, dave.address, '1'
      )

      this.holderVotes = '0';
      this.recipientVotes = '0';
    });

    it('sender delegation', async function () {

      await this.register.connect(deployer).delegate(deployer.address, this.token1.address);

      expect(await this.token1.connect(deployer).transfer(dave.address, '1')).to.emit(
        'Transfer'
      ).withArgs(deployer.address, dave.address, '1').and.to.emit(
        'DelegateVotesChanged'
      ).withArgs(
        this.token1.address, deployer.address, supply, supply.sub(1)
      )

      // expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: deployer.address, previousBalance: supply, newBalance: supply.subn(1) });

      this.holderVotes = supply.sub(1);
      this.recipientVotes = '0';
    });

    it('receiver delegation', async function () {
      await this.register.connect(dave).delegate(dave.address, this.token1.address);

      expect(await this.token1.connect(deployer).transfer(dave.address, 1)).to.emit('Transfer').withArgs(
        deployer.address, dave.address, '1'
      ).and.to.emit(
        'DelegateVotesChanged'
      ).withArgs(
        this.token1.address, dave.address, '0', '1'
      )
      this.holderVotes = '0';
      this.recipientVotes = '1';
    });

    it('full delegation', async function () {
      await this.register.connect(deployer).delegate(deployer.address, this.token1.address);
      await this.register.connect(dave).delegate(dave.address, this.token1.address);

      expect(await this.token1.connect(deployer).transfer(dave.address, 1)).to.emit(
        'Transfer'
      ).withArgs(this.token1.address, deployer.address, dave.address, '1').and.to.emit('DelegateVotesChanged'
      ).withArgs(this.token1.address, deployer.address, supply, supply.sub(1)).and.to.emit('DelegateVotesChanged'
      ).withArgs(this.token1.address, dave.address, '0', '1')
      // expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: deployer.address, previousBalance: supply, newBalance: supply.subn(1) });
      // expectEvent(receipt, 'DelegateVotesChanged', { delegate: dave.address, previousBalance: '0', newBalance: '1' });

      // const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      // expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.holderVotes = supply.sub(1);
      this.recipientVotes = '1';
    });

    afterEach(async function () {
      await hre.network.provider.request({
        method: "evm_mine",
        params: [],
      });
      expect(await this.register.getVotes(deployer.address, this.token1.address)).to.be.equal(this.holderVotes);
      expect(await this.register.getVotes(dave.address, this.token1.address)).to.be.equal(this.recipientVotes);

      // need to advance 2 blocks to see the effect of a transfer on "getPastVotes"
      // const blockNumber = await time.latestBlock();
      const latestBlock = await hre.ethers.provider.getBlock("latest")
      // await hre.network.provider.request({
      //   method: "evm_mine",
      //   params: [],
      // });
      // await hre.network.provider.request({
      //   method: "evm_mine",
      //   params: [],
      // });
      await hre.network.provider.request({
        method: "evm_mine",
        params: [],
      });
      expect(await this.register.getPastVotes(deployer.address, this.token1.address, latestBlock.number)).to.be.equal(this.holderVotes);
      expect(await this.register.getPastVotes(dave.address, this.token1.address, latestBlock.number)).to.be.equal(this.recipientVotes);
    });
  });
});
