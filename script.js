let n = 0;
document.getElementById('btn').addEventListener('click', () => {
  n++;
  document.getElementById('out').textContent = 'Clicked ' + n + ' time' + (n === 1 ? '' : 's');
  console.log('click', n);
});