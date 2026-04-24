const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
router.post('/registro', async (req, res) => { res.json({ message: 'Registro OK' }); });
router.post('/login', async (req, res) => { res.json({ token: 'test', usuario: { nombre: 'Test' } }); });
router.get('/perfil', async (req, res) => { res.json({ nombre: 'Test' }); });
module.exports = router;
